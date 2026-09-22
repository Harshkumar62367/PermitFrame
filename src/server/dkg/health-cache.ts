import { getDkg } from "./index";
import type { DkgHealth, DkgMode } from "./adapter";
import { LivepeerMcpClient, livepeerConfig } from "../livepeer/mcp-client";

/**
 * Integration health with stale-while-revalidate semantics.
 *
 * The DKG CLI (`dkg status`) takes seconds on a good day and longer on a bad
 * one, and the Livepeer discovery probe is a multi-round network call. Neither
 * may ever run synchronously on a page mount/navigation request path: this
 * module answers instantly from the last known result and revalidates in the
 * background (single-flight per area).
 *
 * Honest states - never inferred from a timeout budget:
 * - "checking": no successful or failed check has completed yet.
 * - "healthy": the most recent check succeeded (and is fresh unless `stale`).
 * - "degraded": the most recent check failed, but a previous one succeeded.
 * - "unavailable": checks have never succeeded.
 * A slow probe can therefore never flip a healthy ledger to offline; the
 * previous result is served (marked `stale`) until the probe settles.
 */

export type IntegrationState = "checking" | "healthy" | "degraded" | "unavailable";

export interface LivepeerHealth {
  endpoint: string;
  keyless: boolean;
  /** Real signal - never assumed healthy. Unknown only before the first check. */
  reachable: boolean;
  detail: string;
}

export interface WatchedDkgHealth extends DkgHealth {
  state: IntegrationState;
  checkedAt: string | null;
  stale: boolean;
}

export interface WatchedLivepeerHealth extends LivepeerHealth {
  state: IntegrationState;
  checkedAt: string | null;
  stale: boolean;
}

export interface IntegrationHealth {
  dkg: WatchedDkgHealth;
  livepeer: WatchedLivepeerHealth;
}

export interface HealthProbes {
  dkg: () => Promise<DkgHealth>;
  livepeer: () => Promise<LivepeerHealth>;
}

const HEALTHY_TTL_MS = 60_000;
const UNHEALTHY_TTL_MS = 15_000;
const LIVEPEER_PROBE_TIMEOUT_MS = 8_000;

export interface HealthCacheConfig {
  healthyTtlMs?: number;
  unhealthyTtlMs?: number;
}

let activeConfig: HealthCacheConfig = {};

function ttlFor(state: IntegrationState): number {
  // Recovering services surface quickly; healthy ones are re-checked lazily.
  if (state === "healthy") return activeConfig.healthyTtlMs ?? HEALTHY_TTL_MS;
  return activeConfig.unhealthyTtlMs ?? UNHEALTHY_TTL_MS;
}

async function defaultDkgProbe(): Promise<DkgHealth> {
  return getDkg().health();
}

/** Read-only capability probe with a tight bound: a hung agent degrades, never hangs. */
async function defaultLivepeerProbe(): Promise<LivepeerHealth> {
  const config = livepeerConfig();
  try {
    const client = new LivepeerMcpClient(config);
    await Promise.race([
      client.listCapabilities(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out after 8s")), LIVEPEER_PROBE_TIMEOUT_MS))
    ]);
    return {
      endpoint: config.endpoint,
      keyless: !config.bearer,
      reachable: true,
      detail: `Livepeer Agent reachable at ${config.endpoint} (${config.bearer ? "API key" : "hosted access"}). Capability and pricing status is reported per production job.`
    };
  } catch (error) {
    // Raw probe text never leaves the server: log it and report a safe
    // diagnostic. The health route masks details as a backstop.
    console.error("[health] livepeer probe failed:", String((error as Error)?.message ?? error).slice(0, 200));
    return {
      endpoint: config.endpoint,
      keyless: !config.bearer,
      reachable: false,
      detail: "Livepeer Agent unreachable - productions will fail until it recovers."
    };
  }
}

const defaultProbes: HealthProbes = { dkg: defaultDkgProbe, livepeer: defaultLivepeerProbe };

interface Slot<T> {
  result: T | null;
  state: IntegrationState;
  checkedAt: number | null;
  refresh: Promise<void> | null;
}

function freshSlot<T>(): Slot<T> {
  return { result: null, state: "checking", checkedAt: null, refresh: null };
}

const slots = {
  dkg: freshSlot<DkgHealth>(),
  livepeer: freshSlot<LivepeerHealth>()
};

function dkgPlaceholder(): DkgHealth {
  let mode: DkgMode = "edge-node";
  try {
    mode = getDkg().mode;
  } catch {
    // Pathological config (unsupported DKG_MODE): the real probe reports the
    // error honestly as unavailable; never throw out of the placeholder.
  }
  return {
    mode,
    healthy: false,
    endpoint: process.env.DKG_ENDPOINT_LABEL ?? "local daemon (127.0.0.1:9200)",
    detail: "Checking proof-ledger diagnostics - workspace data does not depend on this check."
  };
}

function livepeerPlaceholder(): LivepeerHealth {
  const config = livepeerConfig();
  return {
    endpoint: config.endpoint,
    keyless: !config.bearer,
    reachable: false,
    detail: "Checking production service - only approved campaigns may start production jobs."
  };
}

function isFresh(slot: Slot<unknown>): boolean {
  return slot.checkedAt !== null && Date.now() - slot.checkedAt < ttlFor(slot.state);
}

function refreshSlot<T>(slot: Slot<T>, probe: () => Promise<T>, isOk: (result: T) => boolean, label: string): void {
  if (slot.refresh) return;
  slot.refresh = (async () => {
    try {
      const result = await probe();
      const ok = isOk(result);
      const hadResult = slot.result !== null;
      slot.result = result;
      slot.checkedAt = Date.now();
      // Healthy ONLY after a genuinely successful check. A failure after a
      // previous success is degraded; failure with no prior result is
      // unavailable - never healthy, never "offline because slow".
      slot.state = ok ? "healthy" : hadResult || slot.state === "healthy" || slot.state === "degraded" ? "degraded" : "unavailable";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[health] ${label} probe failed:`, message.slice(0, 200));
      slot.checkedAt = Date.now();
      slot.state = slot.result !== null || slot.state === "healthy" || slot.state === "degraded" ? "degraded" : "unavailable";
    } finally {
      slot.refresh = null;
    }
  })();
  // Fire-and-forget by design (SWR): the caller already has its instant
  // answer. The promise never rejects - errors are recorded as states above.
  slot.refresh.catch(() => undefined);
}

function watched<T>(slot: Slot<T>, placeholder: T): T & { state: IntegrationState; checkedAt: string | null; stale: boolean } {
  // Data falls back to the placeholder, but the state must reflect completed
  // checks: a failed first probe is "unavailable", not "checking".
  const state: IntegrationState = slot.checkedAt === null ? "checking" : slot.state;
  return {
    ...(slot.result ?? placeholder),
    state,
    checkedAt: slot.checkedAt !== null ? new Date(slot.checkedAt).toISOString() : null,
    stale: slot.result !== null && !isFresh(slot)
  };
}

/**
 * Instant integration health for request paths. Triggers at most one
 * background revalidation per area and never awaits a CLI/network probe.
 * Probes are injectable for tests; production uses the real adapters.
 */
export async function getIntegrationHealth(
  probes: HealthProbes = defaultProbes,
  config: HealthCacheConfig = {}
): Promise<IntegrationHealth> {
  activeConfig = config;  const dkgSlot = slots.dkg;
  const livepeerSlot = slots.livepeer;
  if (!isFresh(dkgSlot)) refreshSlot(dkgSlot, probes.dkg, (r) => r.healthy, "dkg");
  if (!isFresh(livepeerSlot)) refreshSlot(livepeerSlot, probes.livepeer, (r) => r.reachable, "livepeer");
  return {
    dkg: watched(dkgSlot, dkgPlaceholder()),
    livepeer: watched(livepeerSlot, livepeerPlaceholder())
  };
}

/** Await in-flight background revalidations. Production never needs this; tests do. */
export async function settleIntegrationHealth(): Promise<void> {
  await Promise.all([slots.dkg.refresh, slots.livepeer.refresh].filter((p): p is Promise<void> => p !== null));
}

/** Reset cached health. Test-only: production keeps one process-lifetime cache. */
export function resetIntegrationHealthForTests(): void {
  slots.dkg = freshSlot<DkgHealth>();
  slots.livepeer = freshSlot<LivepeerHealth>();
}
