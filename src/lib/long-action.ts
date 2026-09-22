import { ApiError } from "./api";

/**
 * Shared building blocks for long-running mutation UX.
 *
 * Several actions legitimately wait on proof-ledger reads/writes or
 * permission evaluation, so the browser's own timeout can fire while the
 * server is still working (or has already finished). These helpers keep the
 * timer + timeout-classification logic in one place:
 *
 * - `createSlowTimer` reveals a non-alarming "still working" status after
 *   `LONG_ACTION_SLOW_AFTER_MS` (calm progress, never an error look);
 * - `isClientTimeout` / `longActionErrorMessage` map our own timeout budget
 *   (ApiError status 0) to refresh-first recovery copy instead of "failed".
 *
 * React components should use `useLongAction` (./use-long-action), which
 * wraps these with busy/status/error state and unmount cleanup.
 */

/** Delay before a running action admits it is taking a while. */
export const LONG_ACTION_SLOW_AFTER_MS = 5_000;

/** True when the error is our own client timeout budget expiring - the server may still have succeeded. */
export function isClientTimeout(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 0;
}

/**
 * Resolve an action failure to display copy. Client timeouts get the
 * action-specific recovery message (refresh first - the work may already
 * have completed); server errors keep their honest message; anything else
 * falls back without inventing detail.
 */
export function longActionErrorMessage(error: unknown, timedOutCopy: string, fallbackCopy: string): string {
  if (isClientTimeout(error)) return timedOutCopy;
  if (error instanceof Error && error.message) return error.message;
  return fallbackCopy;
}

/**
 * Start a one-shot slow-status timer. Returns a cancel function - call it
 * on success, failure, and unmount so a stale timer never flips UI state.
 */
export function createSlowTimer(onSlow: () => void, afterMs: number = LONG_ACTION_SLOW_AFTER_MS): () => void {
  const timer = setTimeout(onSlow, afterMs);
  return () => clearTimeout(timer);
}
