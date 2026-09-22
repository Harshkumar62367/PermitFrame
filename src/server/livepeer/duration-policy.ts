/**
 * Single-clip motion duration policy - the ONLY authority for resolving a
 * requested duration into a dispatchable one.
 *
 * Product boundary: PermitFrame supports one short-form campaign clip per
 * motion stage, 3-15 seconds. A coherent 30-60s video cannot be generated
 * in one call; longer ads use a multi-scene workflow (explicit future
 * scope, never implied here).
 *
 * What is verified vs assumed (read this before citing limits):
 * - Live discovery exposes NO duration constraints. Verified read-only
 *   against tools/list + list_capabilities + get_pricing shapes (fields
 *   observed: name/kind/availability/model_id/description/prices - none
 *   duration-related). The metadata path below is ready for when a
 *   provider surface genuinely reports min/max/buckets.
 * - DOCUMENTED_MODEL_POLICIES is empty: no model-specific duration claim
 *   below is backed by a citation, so none is made. Add entries only with
 *   a published source (docs URL, versioned pricing page, observed
 *   provider error) - never from intuition.
 * - The only duration with dispatch evidence in this codebase is the 5s
 *   default used by every motion dispatch to date.
 * Consequence: every resolution without real metadata/metadata-policy
 * backing returns source "product-range-unverified" with modelConstraintKnown
 * false and an honest UI note. Nothing here claims "model X supports 3-15s".
 */

export const GLOBAL_MIN_SECONDS = 3;
export const GLOBAL_MAX_SECONDS = 15;

/** Provider-reported duration constraints, when genuinely available. */
export interface DurationMetadata {
  minSeconds?: number;
  maxSeconds?: number;
  /** Discrete renderable lengths, ascending. Null/absent = continuous range. */
  bucketsSeconds?: number[] | null;
  /** Where the metadata came from (tool/endpoint name). */
  source?: string;
}

export interface ModelDurationPolicy {
  minSeconds: number;
  maxSeconds: number;
  bucketsSeconds: number[] | null;
  /** Published source for the claim (docs URL, versioned page, observed error). Required. */
  citation: string;
}

/**
 * Cited model-specific duration policies. EMPTY until a claim ships with a
 * citation - an entry here means "verified", so intuition never qualifies.
 * Shape reference (do not add without filling citation):
 *   "example-model-i2v": { minSeconds: 4, maxSeconds: 10, bucketsSeconds: [4, 6, 10], citation: "https://…" }
 */
export const DOCUMENTED_MODEL_POLICIES: Record<string, ModelDurationPolicy> = {};

/** Lookup a cited policy, if one exists. Test asserts this stays empty until cited. */
export function lookupDocumentedPolicy(capability: string): ModelDurationPolicy | undefined {
  return DOCUMENTED_MODEL_POLICIES[capability];
}

export type DurationSource = "provider-metadata" | "documented-model-policy" | "product-range-unverified";

export type DurationResolution =
  | {
      ok: true;
      requestedSeconds: number;
      resolvedSeconds: number;
      adjusted: boolean;
      adjustmentReason?: string;
      /** Where the applied limits came from - never claims more than known. */
      source: DurationSource;
      /** True only with provider metadata or a cited documented policy. */
      modelConstraintKnown: boolean;
      /** Honest UI/provenance note, set when constraints are unverified. */
      note?: string;
    }
  | { ok: false; error: string };

/** Global range gate: reject outside 3-15s, never silently clamp. */
export function validateDurationRequest(value: unknown): { ok: true; seconds: number } | { ok: false; error: string } {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return { ok: false, error: "Motion length must be a number of seconds." };
  }
  if (!Number.isInteger(n)) {
    return { ok: false, error: "Motion length must be a whole number of seconds." };
  }
  if (n < GLOBAL_MIN_SECONDS || n > GLOBAL_MAX_SECONDS) {
    return {
      ok: false,
      error: `Motion length must be ${GLOBAL_MIN_SECONDS}-${GLOBAL_MAX_SECONDS} seconds (single clip). Longer ads use a multi-scene workflow.`
    };
  }
  return { ok: true, seconds: n };
}

function nearestBucket(requested: number, buckets: number[]): number {
  let best = buckets[0];
  let bestDist = Math.abs(requested - best);
  for (const b of buckets.slice(1)) {
    const dist = Math.abs(requested - b);
    // Equal distance chooses the higher bucket (more of the requested story).
    if (dist < bestDist || (dist === bestDist && b > best)) {
      best = b;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Resolve a requested clip length for one motion capability. Pure and
 * total: every path returns a resolution or a clear rejection.
 */
export function resolveMotionDuration(
  requestedSeconds: number,
  capability: string,
  metadata?: DurationMetadata | null
): DurationResolution {
  const checked = validateDurationRequest(requestedSeconds);
  if (!checked.ok) return { ok: false, error: checked.error };
  const requested = checked.seconds;

  const documented = lookupDocumentedPolicy(capability);
  const metaBuckets = (metadata?.bucketsSeconds ?? null)?.filter(
    (b): b is number => typeof b === "number" && Number.isFinite(b) && b > 0
  ).sort((a, b) => a - b) ?? null;
  const hasMetadata =
    metadata?.minSeconds !== undefined ||
    metadata?.maxSeconds !== undefined ||
    (metaBuckets !== null && metaBuckets.length > 0);

  // Only genuinely-backed constraints are model-aware. Unknown models and
  // metadata-less calls fall through to the provisional product boundary.
  const source: DurationSource = hasMetadata
    ? "provider-metadata"
    : documented
      ? "documented-model-policy"
      : "product-range-unverified";
  const modelConstraintKnown = source !== "product-range-unverified";
  const docBuckets = (documented?.bucketsSeconds ?? null)?.filter(
    (b): b is number => typeof b === "number" && Number.isFinite(b) && b > 0
  ).sort((a, b) => a - b) ?? null;
  const buckets = metaBuckets ?? docBuckets;
  const min = metadata?.minSeconds ?? documented?.minSeconds ?? GLOBAL_MIN_SECONDS;
  const max = metadata?.maxSeconds ?? documented?.maxSeconds ?? GLOBAL_MAX_SECONDS;
  const note = modelConstraintKnown
    ? undefined
    : `This selected model has no published duration metadata in Livepeer discovery. PermitFrame will request a ${requested}s single clip; provider validation still applies.`;

  if (requested < min || requested > max) {
    return {
      ok: false,
      error:
        requested < min
          ? `${capability} renders minimum ${min}s clips - requested ${requested}s is below it. Pick at least ${min}s.`
          : `${capability} renders maximum ${max}s clips - requested ${requested}s exceeds it. Single clip duration; longer ads use a multi-scene workflow.`
    };
  }
  if (buckets && buckets.length > 0 && !buckets.includes(requested)) {
    const resolved = nearestBucket(requested, buckets);
    const listed =
      buckets.length === 1
        ? `${buckets[0]}s`
        : `${buckets.slice(0, -1).map((b) => `${b}s`).join(", ")}, or ${buckets.at(-1)}s`;
    return {
      ok: true,
      requestedSeconds: requested,
      resolvedSeconds: resolved,
      adjusted: true,
      adjustmentReason: `Adjusted from ${requested}s to ${resolved}s because this motion model renders ${listed} clips.`,
      source,
      modelConstraintKnown,
      ...(note ? { note } : {})
    };
  }
  return {
    ok: true,
    requestedSeconds: requested,
    resolvedSeconds: requested,
    adjusted: false,
    source,
    modelConstraintKnown,
    ...(note ? { note } : {})
  };
}
