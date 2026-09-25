/**
 * Preservation provenance display contract (client-safe, no node imports).
 *
 * Every source-guided visual stage records HOW its pixels relate to the
 * approved reference: the mode that was requested, the mode that actually
 * ran, and the evidence level the result may truthfully claim. This module
 * turns those structured fields into compact UI copy - never the reverse
 * (no parsing display text back into state).
 */

export type PreservationMode = "source-guided-generation" | "subject-placement" | "product-photo" | "variation";

/**
 * What the finished output may truthfully be described as:
 * - "source-guided": composed with the approved reference as guidance.
 * - "subject-preserving": the subject-placement operation succeeded.
 * - "product-preserving": identity check passed on a product-preserving stage.
 * - "property-preserving": identity check passed on a property-preserving stage.
 * - "none": no preservation claim (legacy rows, motion/audio stages,
 *   or a variation derived from a prior output rather than the source).
 */
export type PreservationEvidenceLevel = "source-guided" | "subject-preserving" | "product-preserving" | "property-preserving" | "none";

export interface PreservationProvenance {
  preservationRequested?: PreservationMode;
  preservationResolved?: PreservationMode;
  preservationEvidenceLevel?: PreservationEvidenceLevel;
  preservationRequestedCapability?: string;
  preservationActualCapability?: string;
  approvedSourceAssetId?: string;
  sourceStageId?: string;
  fallbackReason?: string;
  providerOperationSucceeded?: boolean;
}

export interface PreservationIndicator {
  /** Compact pill copy, e.g. "Subject-preserving". Null = show nothing. */
  label: string | null;
  /** Fallback flag rendered alongside the label when set. */
  fallbackUsed: boolean;
  /** Full sentence for tooltips / expandable detail. */
  detail: string;
}

/**
 * Normalize legacy rows (pre-preservation fields) so old campaigns render
 * without special cases downstream. Unknown past = no claim, never a guess.
 */
export function normalizePreservation(row: PreservationProvenance | undefined | null): Required<
  Pick<PreservationProvenance, "preservationEvidenceLevel">
> &
  PreservationProvenance {
  if (!row) return { preservationEvidenceLevel: "none" };
  return { ...row, preservationEvidenceLevel: row.preservationEvidenceLevel ?? "none" };
}

export function preservationIndicator(row: PreservationProvenance | undefined | null): PreservationIndicator {  const p = normalizePreservation(row);
  const fallbackUsed = typeof p.fallbackReason === "string" && p.fallbackReason.length > 0;
  const fallbackSuffix = fallbackUsed ? " Preservation fallback used." : "";
  switch (p.preservationEvidenceLevel) {
    case "subject-preserving":
      return {
        label: "Subject-preserving",
        fallbackUsed,
        detail: `Rendered with subject placement against the approved reference.${fallbackSuffix}`
      };
    case "product-preserving":
      return {
        label: "Product-preserving",
        fallbackUsed,
        detail: `Rendered with the product-photo operation against the approved reference.${fallbackSuffix}`
      };
    case "source-guided":
      return {
        // After a fallback the output was rendered guided no matter what
        // was requested: the label names what ran, the detail keeps the
        // request context and the reason.
        label:
          fallbackUsed || p.preservationRequested === "source-guided-generation" || !p.preservationRequested
            ? "Guided by approved reference"
            : p.preservationRequested === "product-photo"
              ? "Product-reference guided"
              : "Variation of approved output",
        fallbackUsed,
        detail:
          p.preservationRequested === "product-photo"
            ? `Composed with the approved product reference as guidance; exact product preservation is unclaimed.${fallbackSuffix}`
            : p.preservationRequested === "variation" && !fallbackUsed
              ? `A controlled variation of a completed approved output; identity preservation is unclaimed.${fallbackSuffix}`
              : `Composed with the approved reference as guidance; exact identity preservation is unclaimed.${fallbackSuffix}`
      };
    case "none":
    default:
      return {
        label: p.preservationResolved && p.preservationResolved !== "source-guided-generation" ? "No preservation claim" : null,
        fallbackUsed,
        detail: fallbackUsed
          ? `Preservation fallback used: ${p.fallbackReason}`
          : "No source-preservation claim is recorded for this output."
      };
  }
}

/** Honest copy for conceptual (reference-guided) outputs. Never a preservation claim. */
export const REFERENCE_GUIDED_COPY = "Reference-guided - exact identity is not guaranteed.";

/** Customer-facing fidelity pill per output. Null = no pill (unknown/legacy). */
export interface FidelityPill {
  label: "Product preserved" | "Property preserved" | "Reference-guided" | "Preservation failed";
  tone: "emerald" | "rose" | "muted";
}

/**
 * Fidelity pill from receipt-level fields. Labels are earned, never
 * defaulted: "preserved" requires a passed fidelity check on a strict
 * stage; "Reference-guided" requires a conceptual source-guided image
 * render; anything unverified or legacy renders nothing.
 */
export function fidelityPillFor(
  receipt: {
    sourceFidelity?: "conceptual" | "product-preserving" | "property-preserving";
    fidelityCheck?: "passed" | "failed";
    role?: string;
    mediaType?: string;
  } | null | undefined
): FidelityPill | null {
  if (!receipt) return null;
  if (receipt.fidelityCheck === "failed") return { label: "Preservation failed", tone: "rose" };
  if (receipt.fidelityCheck === "passed") {
    if (receipt.sourceFidelity === "product-preserving") return { label: "Product preserved", tone: "emerald" };
    if (receipt.sourceFidelity === "property-preserving") return { label: "Property preserved", tone: "emerald" };
    return null;
  }
  if (
    (receipt.sourceFidelity === undefined || receipt.sourceFidelity === "conceptual") &&
    receipt.role === "sourceGuidedImage" &&
    receipt.mediaType === "image"
  ) {
    return { label: "Reference-guided", tone: "muted" };
  }
  return null;
}
