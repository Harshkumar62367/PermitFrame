import "server-only";
import { getCurrentSession } from "./auth";
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
  platforms: string[];
  countries: string[];
  allowedTransformations: string[];
}

export interface CreatorSummary {
  id: string;
  name: string;
  handle: string;
}

export interface WorkspaceSnapshot extends WorkspaceOverview {
  productFacts: ProductFacts[];
  sourceMedia: SourceMedia[];
  consentInvites: Database["consentInvites"];
  passports: PassportSummary[];
  creators: CreatorSummary[];
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
  // Read-only like the overview: effective statuses are derived in memory.
  const db = await loadDb();
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
      ual: p.ual ?? null,
      platforms: p.platforms,
      countries: p.countries,
      allowedTransformations: p.allowedTransformations
    })),
    creators: db.creators.map((c) => ({ id: c.id, name: c.name, handle: c.handle }))
  };
}
