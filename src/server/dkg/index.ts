import type { DkgAdapter } from "./adapter";
import { FileDkgAdapter } from "./file-adapter";
import { DkgJsAdapter } from "./dkgjs-adapter";

let instance: DkgAdapter | null = null;

/**
 * DKG_MODE=real  -> publish/query the OriginTrail DKG via dkg.js (testnet).
 * otherwise      -> local evidence store with identical schemas/semantics.
 */
export function getDkg(): DkgAdapter {
  if (instance) return instance;
  instance = process.env.DKG_MODE === "real" ? new DkgJsAdapter() : new FileDkgAdapter();
  return instance;
}
