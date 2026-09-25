/**
 * Honest upload progress states for the Media Library XHR flow. Browsers
 * report request-byte transmission only: 0-99% means bytes are still
 * leaving the browser, and reaching 100% transmitted does NOT mean the
 * server persisted anything (Cloudinary delivery, hashing, workspace
 * persistence, and evidence recording all run after the bytes arrive).
 * The UI therefore shows two truthful phases - "uploading" with a capped
 * percentage, then an indeterminate "processing" state - and only reports
 * completion on the server's success response. Pure and unit-tested.
 */

export type UploadPhase = "uploading" | "processing";

export interface UploadProgress {
  phase: UploadPhase;
  /** Transmitted percentage, capped at 99 while uploading; null while processing. */
  pct: number | null;
}

/** Map transmitted bytes onto an honest progress state. Never yields 100. */
export function progressForTransmittedBytes(loaded: number, total: number): UploadProgress {
  if (!Number.isFinite(total) || total <= 0 || loaded < total) {
    const pct = total > 0 ? Math.min(99, Math.round((Math.max(0, loaded) / total) * 100)) : 0;
    return { phase: "uploading", pct };
  }
  return { phase: "processing", pct: null };
}

/**
 * Whether a finished-without-success request leaves the outcome unknown
 * (the server may still complete the work) and the UI should reconcile by
 * re-reading the library. HTTP 4xx is a definitive rejection - nothing to
 * reconcile. Timeouts, network failures (status 0), and 5xx are unknown.
 */
export function shouldReconcileAfterUploadFailure(status: number): boolean {
  return status === 0 || status >= 500;
}

/**
 * Typed browser-side upload cancellation. The message is never displayed -
 * callers branch on instanceof so a cancel can never surface as a generic
 * failure. The phase records whether bytes had fully left the browser when
 * abort fired: "uploading" means the server never received a complete
 * body (nothing to reconcile), "processing" means server-side work may
 * still finish (reconcile before retrying).
 */
export class UploadCancelledError extends Error {
  readonly phase: "uploading" | "processing";
  constructor(phase: "uploading" | "processing") {
    super("Upload cancelled");
    this.name = "UploadCancelledError";
    this.phase = phase;
  }
}

export type UploadOutcome =
  | { kind: "cancelled"; phase: "uploading" | "processing" }
  | { kind: "failed"; status: number };

/** Classify a postUpload rejection so cancels never render as failures. Pure and unit-tested. */
export function classifyUploadError(error: unknown): UploadOutcome {
  if (error instanceof UploadCancelledError) return { kind: "cancelled", phase: error.phase };
  const status = error instanceof Error ? ((error as Error & { status?: number }).status ?? -1) : -1;
  return { kind: "failed", status };
}
