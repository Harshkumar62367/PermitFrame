import type { DkgAdapter } from "./adapter";
import { FileDkgAdapter } from "./file-adapter";
import { DkgJsAdapter } from "./dkgjs-adapter";
import { EdgeNodeAdapter } from "./edge-node-adapter";

let instance: DkgAdapter | null = null;

/**
 * DKG_MODE=edge  -> local OriginTrail Edge Node daemon (dkg CLI, SWM + testnet evidence).
 * DKG_MODE=real  -> publish/query the OriginTrail DKG via dkg.js (remote OT-node).
 * otherwise      -> local evidence store with identical schemas/semantics.
 */
export function getDkg(): DkgAdapter {
  if (instance) return instance;
  const mode = process.env.DKG_MODE;
  instance = mode === "edge" ? new EdgeNodeAdapter() : mode === "real" ? new DkgJsAdapter() : new FileDkgAdapter();
  return instance;
}
