import type { DkgAdapter } from "./adapter";
import { FileDkgAdapter } from "./file-adapter";
import { EdgeNodeAdapter } from "./edge-node-adapter";

let instance: DkgAdapter | null = null;

/**
 * DKG_MODE=edge  -> OriginTrail DKG V10 Edge Node (local during development).
 * DKG_MODE unset -> local evidence store with identical schemas/semantics.
 * Any other value fails loudly so deployment cannot silently claim the wrong DKG mode.
 */
export function getDkg(): DkgAdapter {
  if (instance) return instance;
  const mode = process.env.DKG_MODE;
  if (mode === "edge") {
    instance = new EdgeNodeAdapter();
  } else if (!mode || mode === "local") {
    instance = new FileDkgAdapter();
  } else {
    throw new Error(`Unsupported DKG_MODE=${JSON.stringify(mode)}. Use "edge" for OriginTrail DKG V10 or omit it for local evidence.`);
  }
  return instance;
}
