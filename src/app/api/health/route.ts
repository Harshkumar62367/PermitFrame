import { NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { getDkg } from "@/server/dkg";
import type { DkgHealth } from "@/server/dkg/adapter";
import { LivepeerMcpClient, livepeerConfig } from "@/server/livepeer/mcp-client";

export const dynamic = "force-dynamic";

const HEALTH_TTL_MS = 30_000;
let cached: { value: { dkg: DkgHealth; livepeer: LivepeerHealth }; expiresAt: number } | null = null;
let pending: Promise<{ dkg: DkgHealth; livepeer: LivepeerHealth }> | null = null;

export interface LivepeerHealth {
  endpoint: string;
  keyless: boolean;
  /** Real signal — never assumed healthy. Unknown only before the first check. */
  reachable: boolean;
  detail: string;
}

async function getCachedDkgHealth() {
  if (cached && cached.expiresAt > Date.now()) return cached.value.dkg;
  return null;
}

/** Read-only capability probe with a tight bound: a hung agent must degrade, never hang this route. */
async function checkLivepeer(): Promise<LivepeerHealth> {
  const config = livepeerConfig();
  try {
    const client = new LivepeerMcpClient(config);
    await Promise.race([
      client.listCapabilities(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out after 8s")), 8000))
    ]);
    return {
      endpoint: config.endpoint,
      keyless: !config.bearer,
      reachable: true,
      detail: `Livepeer Agent reachable at ${config.endpoint} (${config.bearer ? "API key" : "hosted access"}). Capability and pricing status is reported per production job.`
    };
  } catch (error) {
    return {
      endpoint: config.endpoint,
      keyless: !config.bearer,
      reachable: false,
      detail: `Livepeer Agent unreachable — productions will fail until it recovers. ${(error instanceof Error ? error.message : String(error)).slice(0, 140)}`
    };
  }
}

async function getHealth() {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (!pending) {
    pending = (async () => {
      const [dkg, livepeer] = await Promise.all([
        (async () => {
          const previous = await getCachedDkgHealth();
          try {
            return await getDkg().health();
          } catch {
            return previous ?? { mode: getDkg().mode, healthy: false, detail: "DKG health check failed." };
          }
        })(),
        checkLivepeer()
      ]);
      const value = { dkg, livepeer };
      cached = { value, expiresAt: Date.now() + HEALTH_TTL_MS };
      return value;
    })().finally(() => {
      pending = null;
    });
  }
  return pending;
}

/**
 * Low-priority integration health, decoupled from workspace data.
 * No workspace reads, no seeding — the sidebar polls this independently
 * while the dashboard renders from /api/overview.
 */
export async function GET() {
  try {
    await requireCurrentSession();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    throw error;
  }
  const health = await getHealth();
  return NextResponse.json(health);
}
