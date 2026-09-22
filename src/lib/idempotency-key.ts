/**
 * Client-side idempotency key stability for campaign creation.
 *
 * The key must survive retries of the *same* submission (network failure
 * after server-side persistence replays the original campaign instead of
 * duplicating it) and must change for any intentional edit (a new payload
 * is a new submission). Keyed by byte-identical serialized payload.
 */
export interface SubmissionAttempt {
  payload: string;
  key: string;
}

export function stableAttemptKey(
  prev: SubmissionAttempt | null,
  payload: string,
  mintKey: () => string
): SubmissionAttempt {
  if (prev && prev.payload === payload) return prev;
  return { payload, key: mintKey() };
}

/**
 * Fresh client-generated run key (one per deliberate submit action).
 * Repeats of the same key replay the existing run server-side instead of
 * dispatching duplicate paid jobs. Impure by design - call only from event
 * handlers, never during render.
 */
export function newRunKey(prefix = "studio"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
