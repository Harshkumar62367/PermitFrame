import type { Database } from "../types";
import type { KaRecord } from "./adapter";

/**
 * Workspace-safe proof-record reads. The DKG adapters expose a global
 * listAssets() which is NOT an authorization boundary - the shared graph
 * is public by design and the local store has no workspace concept. So the
 * route derives the current workspace's permitted proof references from
 * its own database and returns only matching shared/anchored records:
 * - match by the workspace's known identifiers (code-owned KA URNs, stored
 *   UALs, stored evidence URIs) - never by caller-supplied identifiers;
 * - only publicationStatus shared/anchored;
 * - never content marked pf:visibility === "private" (belt-and-braces
 *   against pre-fix leaks), never local or failed rows.
 * Unknown, foreign, private, and local records are all excluded - the
 * Graph view fails closed.
 */

export interface WorkspaceProofRefs {
  /** Exact identifiers: KA URNs, stored UALs, stored evidence URIs. */
  urns: Set<string>;
  /**
   * Amendment URN prefixes (`urn:permitframe:amendment:<passportId>:`),
   * one per workspace passport. Amendments carry a timestamp suffix, so
   * they match by prefix - the trailing colon keeps sibling ids distinct.
   */
  amendmentPrefixes: string[];
}

/** Every proof reference the workspace database knows, for one workspace. */
export function collectWorkspaceProofRefs(db: Database): WorkspaceProofRefs {
  const urns = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) urns.add(value);
  };
  const amendmentPrefixes: string[] = [];
  for (const p of db.passports ?? []) {
    urns.add(`urn:permitframe:passport:${p.id}`);
    add(p.ual);
    amendmentPrefixes.push(`urn:permitframe:amendment:${p.id}:`);
  }
  for (const f of db.productFacts ?? []) {
    urns.add(`urn:permitframe:product-facts:${f.id}`);
    add(f.ual);
  }
  for (const m of db.sourceMedia ?? []) {
    urns.add(`urn:permitframe:media:${m.id}`);
    add(m.ual);
  }
  for (const c of db.campaigns ?? []) {
    urns.add(`urn:permitframe:campaign:${c.id}`);
    add(c.campaignUAL);
    for (const r of c.receipts ?? []) {
      urns.add(`urn:permitframe:receipt:${r.id}`);
      add(r.ual);
    }
  }
  return { urns, amendmentPrefixes };
}

/** Whether one adapter record may be shown to the owning workspace. */
export function isWorkspaceRecord(asset: KaRecord, refs: WorkspaceProofRefs): boolean {
  if (asset.publicationStatus !== "shared" && asset.publicationStatus !== "anchored") return false;
  if (asset.content["pf:visibility"] === "private") return false;
  const id = typeof asset.content["@id"] === "string" ? asset.content["@id"] : "";
  if (id !== "" && refs.urns.has(id)) return true;
  if (id !== "") {
    for (const prefix of refs.amendmentPrefixes) {
      if (id.startsWith(prefix)) return true;
    }
  }
  const ual = asset.ual || "";
  if (ual !== "" && refs.urns.has(ual)) return true;
  const evidenceUri = asset.evidenceUri || "";
  if (evidenceUri !== "" && refs.urns.has(evidenceUri)) return true;
  return false;
}

/** Workspace-safe subset of an adapter asset list (order-preserving). */
export function filterWorkspaceRecords(assets: KaRecord[], refs: WorkspaceProofRefs): KaRecord[] {
  return assets.filter((a) => isWorkspaceRecord(a, refs));
}
