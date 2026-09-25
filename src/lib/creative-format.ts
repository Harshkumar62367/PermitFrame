/** Current `create_media` schema constraint, shared by UI and dispatch. */
const CREATIVE_ASPECTS = new Set(["1:1", "16:9", "9:16", "2.35:1", "3:2", "2:3", "4:3", "3:4"]);

// The Creative API accepts these enums generally, but Qwen's current
// source-guided path has returned square files for non-square requests.
// Keep it available for square work, never silently use it for a planned
// non-square placement until the provider demonstrates reliable support.
const CAPABILITY_ASPECTS: Record<string, ReadonlySet<string>> = {
  "qwen-image-3-t2i": new Set(["1:1"])
};

export function unsupportedCreativeFormatReason(capability: string, aspectRatio: string | undefined): string | null {
  if (aspectRatio && !CREATIVE_ASPECTS.has(aspectRatio)) {
    return `Aspect ratio "${aspectRatio}" is not accepted by the current Livepeer Creative API for any model. Choose 1:1, 9:16, or 16:9.`;
  }
  const supportedByCapability = CAPABILITY_ASPECTS[capability];
  if (aspectRatio && supportedByCapability && !supportedByCapability.has(aspectRatio)) {
    return `Model "${capability}" is not enabled for ${aspectRatio} because it has not reliably delivered that planned format.`;
  }
  return null;
}
