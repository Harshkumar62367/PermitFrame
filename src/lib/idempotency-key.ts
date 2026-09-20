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
