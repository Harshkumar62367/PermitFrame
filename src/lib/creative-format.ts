/** Current `create_media` schema constraint, shared by UI and dispatch. */
const CREATIVE_ASPECTS = new Set(["1:1", "16:9", "9:16", "2.35:1", "3:2", "2:3", "4:3", "3:4"]);

export function unsupportedCreativeFormatReason(_capability: string, aspectRatio: string | undefined): string | null {
  if (aspectRatio && !CREATIVE_ASPECTS.has(aspectRatio)) {
    return `Aspect ratio "${aspectRatio}" is not accepted by the current Livepeer Creative API for any model. Choose 1:1, 9:16, or 16:9.`;
  }
  return null;
}
