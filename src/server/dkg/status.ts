import { NextResponse } from "next/server";
import type { WorkspaceSession } from "../auth";
import type { Database } from "../types";
import { publicDkgStatus, type DkgAdapter } from "./adapter";
import { logDkgError } from "./public-errors";
import { collectWorkspaceProofRefs, filterWorkspaceRecords } from "./workspace-records";
import { baseSepoliaTransactionUrl } from "@/lib/proof-links";

/**
 * Workspace-safe proof status behind /api/dkg. Purely injectable for
 * tests (no Next request scope, no database):
 * - no session: real HTTP 401 with the exact contract, before touching
 *   the adapter or the database;
 * - session: adapter health (static projection only) plus the adapter
 *   asset list narrowed to this workspace's permitted shared/anchored
 *   records. Adapter, database, or empty-workspace failures fail closed
 *   to an empty record list - never to another workspace's data and
 *   never to private/local rows.
 */
export async function dkgStatusResponse(
  session: WorkspaceSession | null,
  dkg: DkgAdapter,
  loadDb: () => Promise<Database | null>
): Promise<NextResponse> {
  if (!session) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  let healthy = false;
  try {
    healthy = (await dkg.health()).healthy;
  } catch (error) {
    logDkgError("dkg-status", error);
    healthy = false;
  }
  let assets: Awaited<ReturnType<DkgAdapter["listAssets"]>> = [];
  try {
    assets = await dkg.listAssets().catch(() => []);
  } catch (error) {
    logDkgError("dkg-status", error);
    assets = [];
  }
  let db: Database | null = null;
  try {
    db = await loadDb();
  } catch (error) {
    logDkgError("dkg-status", error);
    db = null;
  }
  const refs = db
    ? collectWorkspaceProofRefs(db)
    : { urns: new Set<string>(), amendmentPrefixes: [] as string[] };
  const visible = filterWorkspaceRecords(assets, refs).map((asset) => {
    const { txHash: rawTxHash, ...publicAsset } = asset;
    const txHash = asset.publicationStatus === "anchored"
      && baseSepoliaTransactionUrl(asset.ual, rawTxHash)
      ? rawTxHash?.trim()
      : undefined;
    return { ...publicAsset, ...(txHash ? { txHash } : {}) };
  });
  return NextResponse.json({ health: publicDkgStatus(dkg.mode, healthy), assets: visible });
}
