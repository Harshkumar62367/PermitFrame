import "server-only";
import { getCurrentSession } from "./auth";
import { reconcileCampaignStatus } from "./campaign-status";
import { loadDb } from "./store";
import { buildWorkspaceOverview, type WorkspaceOverview } from "./overview";
import { expiryWarnings } from "./platform";
import type { Database, ProductFacts, SourceMedia } from "./types";

export interface PassportSummary {
  id: string;
  creatorId: string;
  creatorName: string;
  status: string;
  validUntil: string;
  ual: string | null;
}

export interface WorkspaceSnapshot extends WorkspaceOverview {
  productFacts: ProductFacts[];
  sourceMedia: SourceMedia[];
  consentInvites: Database["consentInvites"];
  passports: PassportSummary[];
}

/**
 * One authenticated read for the whole workspace: the shared overview builder
 * (campaigns with corrected statuses, metrics, pipeline, activity) plus
 * product facts, source media, consent invites and passport summaries.
 * No DKG or Livepeer calls — integration health loads independently and must
 * never block workspace views. This function performs exactly one loadDb()
 * call; status repairs only write when a row has actually drifted.
 */
export async function getWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
  const db = await loadDb();
  for (const c of db.campaigns) {
    await reconcileCampaignStatus(c).catch(() => undefined);
  }
  const session = await getCurrentSession().catch(() => null);
  const overview = buildWorkspaceOverview(db, session?.workspaceName ?? null, await expiryWarnings(30, db));
  return {
    ...overview,
    productFacts: db.productFacts,
    sourceMedia: db.sourceMedia,
    consentInvites: db.consentInvites,
    passports: db.passports.map((p) => ({
      id: p.id,
      creatorId: p.creatorId,
      creatorName: p.creatorName,
      status: p.status,
      validUntil: p.validUntil,
      ual: p.ual ?? null
    }))
  };
}
