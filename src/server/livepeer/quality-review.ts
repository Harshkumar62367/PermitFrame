import { deliveryBlockReason } from "../types";
import type { DerivativeReceipt, ProductionJob } from "../types";

/**
 * Reviewer-facing quality state for one generated asset. Pure (no I/O, no
 * provider calls): derives a small typed state from the persisted advisory
 * critique fields and the hard delivery block. Advisory critique never
 * approves, rejects, regenerates, or publishes - it only informs the human.
 */

export type QualityReviewState = "delivery_blocked" | "needs_attention" | "reviewed" | "not_assessed";

/** Display cap for persisted critique notes (persisted notes run to 300). */
export const QUALITY_NOTE_DISPLAY_MAX = 160;

export interface QualityReview {
  state: QualityReviewState;
  /** Safe display-ready critique note, or null when there is none to show. */
  note: string | null;
}

/**
 * Collapse whitespace and cap length for display. Returns null for
 * missing/blank notes so callers render nothing instead of guessing.
 * React escapes rendered text; this only bounds size.
 */
export function truncateQualityNote(note: string | null | undefined, max: number = QUALITY_NOTE_DISPLAY_MAX): string | null {
  if (!note) return null;
  const flat = note.trim().replace(/\s+/g, " ");
  if (!flat) return null;
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Derive the reviewer state. Precedence is fixed: the hard delivery block
 * (ratio mismatch) dominates any critique outcome; an explicit
 * qualityPassed: false needs human attention; a pass counts as reviewed
 * only with an explicit boolean AND a finite score (a missing score/note
 * is never a pass - including the server's null-score advisory pass);
 * anything else is not_assessed. Legacy jobs without quality fields land
 * in not_assessed.
 */
export function deriveQualityReview(
  job: Pick<ProductionJob, "qualityPassed" | "qualityScore" | "qualityNote"> | null | undefined,
  receipt: Pick<DerivativeReceipt, "deliveryBlocked" | "aspectVerdict"> | null | undefined
): QualityReview {
  if (receipt && deliveryBlockReason(receipt) !== null) {
    return { state: "delivery_blocked", note: null };
  }
  if (job?.qualityPassed === false) {
    return { state: "needs_attention", note: truncateQualityNote(job.qualityNote) };
  }
  if (job?.qualityPassed === true && Number.isFinite(job.qualityScore)) {
    return { state: "reviewed", note: null };
  }
  return { state: "not_assessed", note: null };
}

/** Reviewer copy per state. Fixed strings - no provider/model text leaks. */
export function qualityReviewCopy(state: QualityReviewState): string {
  switch (state) {
    case "delivery_blocked":
      return "Not deliverable — ratio mismatch.";
    case "needs_attention":
      return "Needs attention — the automated check flagged this output.";
    case "reviewed":
      return "Automated review found no issue.";
    case "not_assessed":
      return "Not assessed automatically — review this asset before delivery.";
  }
}
