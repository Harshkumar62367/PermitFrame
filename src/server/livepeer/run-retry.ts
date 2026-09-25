import type { ProductionJob } from "../types";
import { resolveEntitlements } from "../entitlements";
import { maskOperationalDetail } from "../dkg/public-errors";
export {
  DEFAULT_PROVIDER_BUDGET_SECONDS,
  PROVIDER_WATCHDOG_GRACE_SECONDS,
  MAX_PROVIDER_WATCHDOG_SECONDS,
  DEFAULT_PROVIDER_WATCHDOG_SECONDS,
  providerWatchdogSeconds
} from "./provider-watchdog";

/**
 * Execution tuning: retry classification, backoff math, error redaction,
 * attempt budgets, concurrency ceilings, and provider kill-switches. Pure
 * except for env reads; dependency-neutral (leaf module - every other
 * run-* module may import it, it imports none of them).
 */

export const DEFAULT_MAX_CONCURRENCY = 3;

/** Effective concurrency ceiling: env override capped by the tier. */
export function resolveMaxConcurrency(): number {
  const tier = resolveEntitlements().maxConcurrentJobs;
  const env = Number.parseInt(process.env.LIVEPEER_MAX_CONCURRENCY ?? "", 10);
  const base = Number.isInteger(env) && env > 0 ? env : DEFAULT_MAX_CONCURRENCY;
  return Math.min(base, tier);
}

/** Max submit attempts per job before the stage fails honestly. */
export function maxDispatchAttempts(): number {
  const env = Number.parseInt(process.env.LIVEPEER_MAX_ATTEMPTS ?? "", 10);
  return Number.isInteger(env) && env > 0 ? env : 5;
}

export type ProviderFailureKind =
  | "worker_reaped"
  | "no_heartbeat"
  | "worker_died"
  | "provider_timeout"
  | "internal_provider_failure"
  | "failed_without_output";

export function classifyProviderFailure(status: string, detail = ""): ProviderFailureKind | undefined {
  const text = `${status} ${detail}`.toLowerCase().replace(/[_-]+/g, " ");
  if (/(network timeout|transport timeout|socket hang up|fetch failed|aborted)/.test(text) && !/(provider|worker|job failed)/.test(text)) return undefined;
  if (/reaped|reap/.test(text)) return "worker_reaped";
  if (/no heartbeat|heartbeat missing|heartbeat timeout/.test(text)) return "no_heartbeat";
  if (/worker died|worker death|worker crashed/.test(text)) return "worker_died";
  if (/provider timeout|provider timed out|timed out|timeout/.test(text)) return "provider_timeout";
  if (/internal provider failure|internal error|provider internal/.test(text)) return "internal_provider_failure";
  if (/failed without output|failed without an output|failed no output|no output|without an output/.test(text)) return "failed_without_output";
  return undefined;
}

export function isRetryableProviderFailure(kind: ProviderFailureKind | undefined): boolean {
  return kind !== undefined;
}

export function maxAutomaticRecoveryAttempts(): number {
  const env = Number.parseInt(process.env.LIVEPEER_MAX_RECOVERY_ATTEMPTS ?? "", 10);
  return Number.isInteger(env) && env > 0 ? Math.min(env, 1) : 1;
}

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 15 * 60_000;

/** Exponential backoff after a failed attempt: 30s, 1m, 2m, 4m … capped at 15m. */
export function computeBackoffMs(attempts: number): number {
  if (!Number.isFinite(attempts) || attempts <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
}

export type SubmitErrorKind = "transient" | "terminal";

/**
 * Terminal rejections (capability gone, invalid input, cost refusal, auth)
 * fail the stage immediately; everything else (timeouts, transport, 5xx,
 * rate limits) is transient and retries with backoff under the same
 * idempotency key.
 */
export function classifySubmitError(message: string): SubmitErrorKind {
  if (
    /not currently available|unsupported|not supported|invalid|rejected|refused|forbidden|unauthorized|exceeds|exceeded|payment|budget|blocked|denied|argument\s+.*must be|must be one of|aspect_ratio/i.test(
      message
    )
  ) {
    return "terminal";
  }
  return "transient";
}

/** True while a job waits out its persisted backoff window. */
export function isBackoffPending(job: ProductionJob, now = Date.now()): boolean {
  if (job.status !== "queued" && job.status !== "generating") return false;
  if (!job.nextAttemptAt) return false;
  const at = Date.parse(job.nextAttemptAt);
  return Number.isFinite(at) && at > now;
}

/** Strip credential-shaped material before persisting an error. */
export function redactSubmitError(message: string): string {
  return maskOperationalDetail(
    message
      .replace(/bearer\s+[^\s]+/gi, "bearer [redacted]")
      .replace(/(api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, "$1 [redacted]")
  ).slice(0, 200);
}

export type PlaceSubjectMode = "auto" | "off";

/** place_subject is schema-validated but response-shape unproven: auto tries it, off skips. */
export function placeSubjectMode(): PlaceSubjectMode {
  return process.env.LIVEPEER_PLACE_SUBJECT === "off" ? "off" : "auto";
}

/** Advisory vision check kill-switch (default on; never fails a stage). */
export function qualityCheckEnabled(): boolean {
  return process.env.LIVEPEER_QUALITY_CHECK !== "off";
}
