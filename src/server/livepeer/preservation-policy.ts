import crypto from "node:crypto";
import type { ProductionStagePlan, StageRole } from "../types";
import type { PreservationEvidenceLevel, PreservationMode } from "@/lib/preservation";

/**
 * Approved-reference / subject / product preservation policy (pure,
 * server-side). For every source-guided visual stage it selects the
 * strongest preservation path the provider surface can honestly serve,
 * validates the inputs before any paid dispatch, and records exactly what
 * happened so the UI and receipts never claim more than the operation did.
 *
 * Modes:
 * - "source-guided-generation": fallback only (create_media image-to-image
 *   with the approved source). Copy says "guided by", never "preserved".
 * - "subject-placement": place_subject, only for eligible image stages with
 *   a usable approved source and live rights.
 * - "product-photo": a dedicated product/packshot capability, only when its
 *   live request/response schema is genuinely known (see
 *   PRODUCT_PHOTO_SUPPORTED - currently deferred, never dispatched blind).
 * - "variation": create_variations, only from an explicitly selected
 *   completed output (user refinement action), never automatic.
 *
 * Support is never inferred from model names. Anything unknown resolves
 * safely to source-guided generation with a visible provenance reason.
 */

export type { PreservationMode, PreservationEvidenceLevel };

/** Tool name the resolved mode intends to dispatch (machine-readable). */
export type PreservationCapability = "create_media" | "place_subject" | "create_variations" | "deferred";

export const PRESERVATION_CAPABILITY_FOR_MODE: Record<PreservationMode, PreservationCapability> = {
  "source-guided-generation": "create_media",
  "subject-placement": "place_subject",
  "product-photo": "deferred",
  variation: "create_variations"
};

/**
 * Product-photo live-schema gate. No product/packshot request/response
 * schema has been validated against the live Creative surface, so the mode
 * resolves to source-guided generation with a typed deferred reason until
 * a schema is proven (observed request + parsed response in tests). Flip
 * only with a validated schema behind it - never on model-name inference.
 */
export function isProductPhotoSupported(): boolean {
  return false;
}

/** Image kinds subject placement may serve. Video, audio, and text-only
 * stages are never eligible - placement would be a blind paid call. */
const SUBJECT_PLACEMENT_KINDS: ReadonlySet<ProductionStagePlan["kind"]> = new Set(["image-to-image", "text-to-image"]);

const VARIATION_KINDS: ReadonlySet<ProductionStagePlan["kind"]> = new Set(["image-to-image", "text-to-image"]);

export interface PreservationContext {
  stageId: string;
  kind: ProductionStagePlan["kind"];
  role: StageRole;
  /** Resolved input URL feeding this dispatch (approved source or prior output). */
  sourceUrl?: string;
  /** Approved source media id, when the input is the campaign's source. */
  sourceAssetId?: string;
  /** Dependency stage id, when the input is a prior stage output. */
  sourceStageId?: string;
  /** Caller-verified: the source belongs to this campaign/workspace. */
  sourceOwnedByCampaign: boolean;
  /** Campaign preflight decision is "allow" right now. */
  rightsAllowed: boolean;
  /** This job is an explicit user refinement (revise / variations action). */
  variationExplicit: boolean;
  /** Selected completed output this refinement varies. */
  variationSourceUrl?: string;
  /** Environment kill-switch state for place_subject. */
  placeSubjectMode: "auto" | "off";
}

export interface SourceValidation {
  sourceUrlUsable: boolean;
  rightsAllowed: boolean;
  sourceOwned: boolean;
}

export interface PreservationDecision {
  requested: PreservationMode;
  resolved: PreservationMode;
  requestedCapability: PreservationCapability;
  /** Tool the resolved mode will actually dispatch. */
  actualCapability: PreservationCapability;
  /** Set when resolved differs from requested - always shown in the UI. */
  fallbackReason?: string;
  /** Hard refusal: do not dispatch at all (fail the stage, spend nothing). */
  refusal?: string;
  approvedSourceAssetId?: string;
  approvedSourceUrlFingerprint?: string;
  sourceStageId?: string;
  /** Claimable level IF the provider operation succeeds (finalize records
   * providerOperationSucceeded; success is never assumed here). */
  evidenceLevel: PreservationEvidenceLevel;
  /** Whether a failed preservation op may fall back once to source-guided
   * create_media (recorded), or must fail the stage instead. */
  allowFallbackToSourceGuided: boolean;
  sourceValidation: SourceValidation;
}

/** Usable source: absolute HTTPS URL (no data:, no relative, no blanks). */
export function isPreservationSourceUsable(url: unknown): url is string {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith("https://")) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" && parsed.hostname.includes(".");
  } catch {
    return false;
  }
}

function fingerprint(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex");
}

/**
 * Defensive output parse for preservation tool responses: only an array
 * carrying at least one usable HTTPS URL counts. Malformed, empty, or
 * junk responses yield undefined - callers must record the failed attempt
 * and never claim success.
 */
export function firstUsableOutput(outputUrls: unknown): string | undefined {
  if (!Array.isArray(outputUrls)) return undefined;
  return outputUrls.find(isPreservationSourceUsable);
}

/**
 * Three-way classification of a preservation tool response (place_subject /
 * create_variations), so async handles are never mistaken for failures:
 * - "inline": a usable output URL is present - finalize it.
 * - "track": no output yet, but a valid non-empty async provider job id -
 *   persist the handle and poll; never submit a fallback while pending.
 * - "empty": neither - malformed, rejected, or blank. Only this case (or a
 *   confirmed terminal poll failure later) may fall back to guided
 *   create_media. A bare non-string/blank job id counts as empty, never a
 *   handle (no invented provider jobs).
 */
export type PreservationCallOutcome =
  | { kind: "inline"; url: string }
  | { kind: "track"; jobId: string }
  | { kind: "empty"; reason: string };

export function classifyPreservationResult(outputUrls: unknown, jobId: unknown): PreservationCallOutcome {
  const url = firstUsableOutput(outputUrls);
  if (url) return { kind: "inline", url };
  // Only a non-empty string tracks: a numeric or structured "handle" is
  // noise, not a provider job - tracking it would poll a phantom id while
  // the real work (if any) goes unobserved.
  if (typeof jobId === "string" && jobId.trim().length > 0) return { kind: "track", jobId: jobId.trim() };
  return { kind: "empty", reason: "Preservation tool returned no usable output and no provider job id." };
}

/**
 * Stable idempotency keys for preservation operations: derived from the
 * job's base key with a fixed suffix, so retries and recovery resume under
 * the SAME key (provider dedupes - no duplicate paid submissions).
 */
export function preservationOperationKey(jobKey: string, op: "place" | "vary"): string {
  return `${jobKey}_${op === "place" ? "place" : "vary"}`;
}

/** Requested mode derived from role + explicit refinement record - never
 * from model names. "variation" is requested only when BOTH hold:
 * variationExplicit === true AND variationSourceUrl is usable. A stale or
 * unexplicit source URL is not a variation request: the role decides, so
 * the record resolves as guided generation and never falsely claims the
 * user asked to vary. */
export function requestedPreservationMode(ctx: Pick<PreservationContext, "role" | "variationExplicit" | "variationSourceUrl">): PreservationMode {
  if (ctx.variationExplicit === true && isPreservationSourceUsable(ctx.variationSourceUrl)) return "variation";
  switch (ctx.role) {
    case "subjectPreservingImage":
      return "subject-placement";
    case "productPackshot":
      return "product-photo";
    default:
      return "source-guided-generation";
  }
}

export function resolvePreservation(ctx: PreservationContext): PreservationDecision {
  const requested = requestedPreservationMode(ctx);
  const sourceUsable = isPreservationSourceUsable(ctx.sourceUrl);
  const sourceValidation: SourceValidation = {
    sourceUrlUsable: sourceUsable,
    rightsAllowed: ctx.rightsAllowed,
    sourceOwned: ctx.sourceOwnedByCampaign
  };
  const base = {
    requested,
    approvedSourceAssetId: ctx.sourceAssetId,
    ...(sourceUsable && ctx.sourceUrl ? { approvedSourceUrlFingerprint: fingerprint(ctx.sourceUrl) } : {}),
    ...(ctx.sourceStageId ? { sourceStageId: ctx.sourceStageId } : {}),
    sourceValidation
  };

  // Rights are re-checked at dispatch: a revoked/expired permission between
  // plan and dispatch must refuse before spend, never render anyway.
  if (!ctx.rightsAllowed) {
    return {
      ...base,
      resolved: "source-guided-generation",
      requestedCapability: PRESERVATION_CAPABILITY_FOR_MODE[requested],
      actualCapability: "create_media",
      evidenceLevel: "none",
      allowFallbackToSourceGuided: false,
      refusal: "Rights are not currently allowed - refusing preservation dispatch before any spend."
    };
  }
  if (!ctx.sourceOwnedByCampaign) {
    return {
      ...base,
      resolved: "source-guided-generation",
      requestedCapability: PRESERVATION_CAPABILITY_FOR_MODE[requested],
      actualCapability: "create_media",
      evidenceLevel: "none",
      allowFallbackToSourceGuided: false,
      refusal: "Source ownership could not be verified for this campaign - refusing preservation dispatch before any spend."
    };
  }

  switch (requested) {
    case "subject-placement": {
      if (!SUBJECT_PLACEMENT_KINDS.has(ctx.kind)) {
        return {
          ...base,
          resolved: "source-guided-generation",
          requestedCapability: "place_subject",
          actualCapability: "create_media",
          evidenceLevel: "none",
          allowFallbackToSourceGuided: false,
          refusal: `Subject placement is not supported for ${ctx.kind} stages - refusing before any spend.`
        };
      }
      if (ctx.placeSubjectMode === "off") {
        return {
          ...base,
          resolved: "source-guided-generation",
          requestedCapability: "place_subject",
          actualCapability: "create_media",
          fallbackReason: "Subject placement is disabled by operator switch; rendered guided by the approved reference instead.",
          evidenceLevel: "source-guided",
          allowFallbackToSourceGuided: true
        };
      }
      if (!sourceUsable) {
        return {
          ...base,
          resolved: "source-guided-generation",
          requestedCapability: "place_subject",
          actualCapability: "create_media",
          evidenceLevel: "none",
          allowFallbackToSourceGuided: false,
          refusal: "Subject placement needs a usable approved source URL - refusing before any spend."
        };
      }
      return {
        ...base,
        resolved: "subject-placement",
        requestedCapability: "place_subject",
        actualCapability: "place_subject",
        evidenceLevel: "subject-preserving",
        allowFallbackToSourceGuided: true
      };
    }
    case "product-photo": {
      // Schema unknown: never dispatch a speculative product capability.
      // Render source-guided, label it accurately, leave a typed reason.
      if (!isProductPhotoSupported()) {
        return {
          ...base,
          resolved: "source-guided-generation",
          requestedCapability: "deferred",
          actualCapability: "create_media",
          fallbackReason:
            "Product-photo capability deferred: no validated live schema for a product-photo operation. Rendered guided by the approved product reference instead; exact product preservation is unclaimed.",
          evidenceLevel: "source-guided",
          allowFallbackToSourceGuided: true
        };
      }
      if (ctx.kind !== "image-to-image" && ctx.kind !== "text-to-image") {
        return {
          ...base,
          resolved: "source-guided-generation",
          requestedCapability: "deferred",
          actualCapability: "create_media",
          evidenceLevel: "none",
          allowFallbackToSourceGuided: false,
          refusal: `Product-photo is not supported for ${ctx.kind} stages - refusing before any spend.`
        };
      }
      if (!sourceUsable) {
        return {
          ...base,
          resolved: "source-guided-generation",
          requestedCapability: "deferred",
          actualCapability: "create_media",
          evidenceLevel: "none",
          allowFallbackToSourceGuided: false,
          refusal: "Product-photo needs a usable approved product reference - refusing before any spend."
        };
      }
      return {
        ...base,
        resolved: "product-photo",
        requestedCapability: "deferred",
        actualCapability: "deferred",
        evidenceLevel: "product-preserving",
        allowFallbackToSourceGuided: true
      };
    }
    case "variation": {
      // Explicit-only gate: variationSourceUrl without the explicit flag is
      // treated as a normal guided render, never an automatic variation.
      if (!ctx.variationExplicit) {
        return {
          ...base,
          requested: "source-guided-generation",
          resolved: "source-guided-generation",
          requestedCapability: "create_media",
          actualCapability: "create_media",
          fallbackReason: "Variation requested without an explicit refinement action - rendered as a normal guided output instead.",
          evidenceLevel: "source-guided",
          allowFallbackToSourceGuided: true
        };
      }
      if (!VARIATION_KINDS.has(ctx.kind)) {
        // Explicit refinements of non-image stages (e.g. motion) still
        // render: guided through the normal path with the reviewer's
        // instructions in the prompt, exactly as before variations existed.
        return {
          ...base,
          resolved: "source-guided-generation",
          requestedCapability: "create_variations",
          actualCapability: "create_media",
          fallbackReason: `Variations only serve image stages - this ${ctx.kind} refinement renders through the normal path instead.`,
          evidenceLevel: "source-guided",
          allowFallbackToSourceGuided: true
        };
      }
      if (!isPreservationSourceUsable(ctx.variationSourceUrl)) {
        return {
          ...base,
          resolved: "source-guided-generation",
          requestedCapability: "create_variations",
          actualCapability: "create_media",
          evidenceLevel: "none",
          allowFallbackToSourceGuided: false,
          refusal: "Variation needs the selected completed output as source - refusing before any spend."
        };
      }
      return {
        ...base,
        resolved: "variation",
        requestedCapability: "create_variations",
        actualCapability: "create_variations",
        evidenceLevel: "none",
        allowFallbackToSourceGuided: true
      };
    }
    case "source-guided-generation":
    default: {
      if (!sourceUsable) {
        return {
          ...base,
          resolved: "source-guided-generation",
          requestedCapability: "create_media",
          actualCapability: "create_media",
          evidenceLevel: "none",
          allowFallbackToSourceGuided: false,
          refusal: "Source-guided generation needs the approved source media - refusing before any spend."
        };
      }
      return {
        ...base,
        resolved: "source-guided-generation",
        requestedCapability: "create_media",
        actualCapability: "create_media",
        evidenceLevel: "source-guided",
        allowFallbackToSourceGuided: true
      };
    }
  }
}
