import type { PermissionPassport, ProductFacts, PublicationStatus, Visibility } from "../types";
import type { KaEnvelope } from "./schemas";

export interface KaRecord {
  /** A public, on-chain Verifiable Memory locator. Empty until VM publish succeeds. */
  ual: string;
  /** DKG V10 Shared Working Memory evidence. This is not an on-chain UAL. */
  evidenceUri?: string;
  merkleRoot?: string;
  /** Base Sepolia transaction that finalized a Verifiable Memory publish. */
  txHash?: string;
  explorerUrl: string;
  /**
   * Explicit state from the real adapter result — never inferred from ID shape.
   * "local" (workspace store), "shared" (SWM), "anchored" (VM finalize
   * succeeded), "failed" (attempted and failed — retryable).
   */
  publicationStatus: PublicationStatus;
  name: string;
  content: Record<string, unknown>;
  publishedAt: string;
  mode: DkgMode;
}

export type DkgMode = "edge-node" | "local-evidence";

export interface DkgHealth {
  mode: DkgMode;
  healthy: boolean;
  endpoint?: string;
  blockchain?: string;
  detail: string;
}

/**
 * The DKG layer governs what the production agent may do:
 * rights + facts go in, policy decisions and receipts come out.
 */
export interface DkgAdapter {
  readonly mode: DkgMode;
  health(): Promise<DkgHealth>;
  publish(ka: KaEnvelope, visibility: Visibility): Promise<KaRecord>;
  /** Publish a minimized, already-shared KA to on-chain Verifiable Memory. */
  publishVerifiable(ka: KaEnvelope, visibility: Visibility): Promise<KaRecord>;
  get(ual: string): Promise<KaRecord | null>;
  sparql(query: string): Promise<Array<Record<string, unknown>>>;
  findApplicablePassports(filter: {
    creatorId: string;
    platform: string;
    country: string;
    onDate: string;
  }): Promise<PermissionPassport[]>;
  /** All passports for a creator regardless of platform/country/validity — used to explain blocks. */
  listPassports(creatorId: string): Promise<PermissionPassport[]>;
  findProductFacts(brand: string, productName: string): Promise<ProductFacts | null>;
  listAssets(): Promise<KaRecord[]>;
}

export function explorerUrlFor(ual: string): string {
  return `https://dkg.origintrail.io/explore?ual=${encodeURIComponent(ual)}`;
}

/**
 * Pure mapping from adapter mode + publish kind to persisted status.
 * Unit-tested: local store is always "local"; edge SWM shares are "shared";
 * only a finalized Verifiable Memory publish is "anchored".
 */
export function basePublicationStatus(mode: DkgMode, verifiable: boolean): PublicationStatus {
  if (mode === "local-evidence") return "local";
  return verifiable ? "anchored" : "shared";
}
