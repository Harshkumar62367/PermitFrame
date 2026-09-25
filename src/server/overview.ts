import { getCurrentSession } from "./auth";
import { effectiveCampaignStatus, productionStage, type ProductionStage } from "./campaign-status";
import { loadDb } from "./store";
import { campaignCostRollup, estimateCost, expiryWarnings, type ExpiryWarning } from "./platform";
import type { Campaign, CampaignStatus, Database, PublicationStatus } from "./types";
import { isActiveJobStatus, isPrivateUpload } from "./types";

export interface OverviewBlocker {
  code: string;
  message: string;
  evidenceRefs: string[];
}

export interface OverviewPreflight {
  /** Live verdict. "pending" means no preflight has run yet - never invent one. */
  decision: "allow" | "block" | "pending";
  checkedAt: string | null;
  blockerCount: number;
  blockers: OverviewBlocker[];
  allowedClaims: string[];
  /** Distinct Knowledge Asset references consulted (passport UALs/ids + facts UALs/ids). */
  knowledgeAssetsConsulted: number;
  queriedRights: string[];
  queriedFacts: string[];
}

export interface OverviewRights {
  passportId: string;
  platforms: string[];
  countries: string[];
  validUntil: string;
  transformations: string[];
  status: string;
  ual: string | null;
}

export interface OverviewFacts {
  id: string;
  approvedClaims: string[];
  ual: string | null;
}

export interface OverviewCampaign {
  id: string;
  title: string;
  /** Stored label, kept for transparency. UI must render `effectiveStatus`. */
  status: string;
  /** Corrected status: the live preflight verdict wins over the stored label. */
  effectiveStatus: CampaignStatus;
  stage: ProductionStage;
  platform: string;
  country: string;
  brand: string;
  productName: string;
  creatorId: string;
  creatorName: string;
  contextNote?: string;
  updatedAt: string;
  /** Source-media image when registered, else the latest generated output. Null when neither exists. */
  thumbnailUrl: string | null;
  /** Latest generated output (Livepeer), when production has produced one. */
  generatedUrl: string | null;
  /** Media type of the latest generated output. Drives image vs video rendering. */
  generatedMediaType: "image" | "video" | null;
  receiptsCount: number;
  /** Campaign evidence record, when approval published one. Null until then. */
  campaignUAL: string | null;
  /** Explicit state from the real publish result. Missing on legacy rows (non-public). */
  recordPublicationStatus: PublicationStatus | null;
  /** Stable public verification reference, set at approval. Null until then. */
  verificationRef: string | null;
  activeJobs: number;
  spentUsd: number;
  /** Planned inference cost of the approved plan. For blocked campaigns this is spend that was prevented. */
  estimatedUsd: number;
  preflight: OverviewPreflight;
  /** Permission evidence behind the verdict, when the passport still exists. Null when revoked/deleted. */
  rights: OverviewRights | null;
  /** Verified product facts behind the verdict, when they still exist. */
  facts: OverviewFacts | null;
}

export interface OperationalMetrics {
  needsAttention: number;
  readyToProduce: number;
  outputsDelivered: number;
  /** Honest, computed number: planned inference cost of blocked campaigns that never ran. */
  spendProtected: number;
  totalSpent: number;
  blockedIds: string[];
  readyIds: string[];
}

export interface PipelineCount {
  stage: ProductionStage;
  label: string;
  count: number;
  campaignIds: string[];
}

export interface OverviewActivityItem {
  id: string;
  at: string;
  kind: string;
  summary: string;
  campaignId: string | null;
  campaignTitle: string | null;
}

export interface WorkspaceOverview {
  workspaceName: string | null;
  campaigns: OverviewCampaign[];
  /** Archived rows for the Campaigns "Archived" filter. Excluded from every metric/pipeline rollup. */
  archivedCampaigns: OverviewCampaign[];
  warnings: ExpiryWarning[];
  totalSpent: number;
  totalOutputs: number;
  metrics: OperationalMetrics;
  pipeline: PipelineCount[];
  /** Newest-first application events. Empty when nothing has happened yet - never fabricated. */
  activity: OverviewActivityItem[];
}

const STAGE_LABELS: Record<ProductionStage, string> = {
  briefed: "Briefed",
  "policy-check": "Permission check",
  ready: "Ready",
  generating: "Generating",
  delivered: "Delivered"
};

const ACTIVITY_LIMIT = 12;

/**
 * One cohesive read for the workspace overview: a single workspace-state
 * load fans out to campaigns (+creator names, thumbnails, preflight
 * summaries), expiry warnings, spend/output rollups, operational metrics,
 * the production pipeline and the real event feed. No DKG or Livepeer calls -
 * integration health loads independently and must never block the dashboard.
 *
 * Stored campaign statuses that drifted from their live preflight verdict are
 * repaired here (one write per drifted row, none otherwise) so KPI totals,
 * badges and verdicts can never contradict each other again.
 */
export async function getWorkspaceOverview(): Promise<WorkspaceOverview> {
  // Read-only: drift is corrected in memory via effectiveCampaignStatus in
  // the builder below. GETs never write, so concurrent reads can't contend
  // on full-blob rewrites. Persistent repair happens on the write path.
  const db = await loadDb();
  const session = await getCurrentSession().catch(() => null);
  return buildWorkspaceOverview(db, session?.workspaceName ?? null, await expiryWarnings(30, db));
}

/** Pure builder over an already-loaded Database. Shared with the workspace snapshot. */
export function buildWorkspaceOverview(db: Database, workspaceName: string | null, warnings: ExpiryWarning[]): WorkspaceOverview {
  const creatorNames = new Map(db.passports.map((p) => [p.creatorId, p.creatorName] as const));
  const mediaById = new Map(db.sourceMedia.map((m) => [m.id, m] as const));
  const titleByCampaignId = new Map(db.campaigns.map((c) => [c.id, c.title] as const));
  // Archived campaigns are audit history: they stay resolvable for activity
  // titles/detail reads but leave every list, metric and pipeline bucket.
  // The row mapper is shared so archived rows render identically in the filter.
  const visible = db.campaigns.filter((c) => c.status !== "archived");
  const toOverviewCampaign = (c: Campaign): OverviewCampaign => {
    const rollup = campaignCostRollup(c);
    const latestReceipt = c.receipts.at(-1) ?? null;
    // Public URL registrations can render directly. Uploads use the
    // workspace-authenticated, same-origin preview route: the browser never
    // sees Cloudinary's storage identifier or a signed delivery URL. Browser
    // lazy loading keeps this to one fetch only when a visible card needs it.
    const media = mediaById.get(c.sourceMediaId);
    const sourceUrl = media?.url ?? null;
    const thumbnailUrl = sourceUrl?.startsWith("http")
      ? sourceUrl
      : media && isPrivateUpload(media) && media.type === "image"
        ? `/api/media/${encodeURIComponent(media.id)}/preview`
        : (latestReceipt?.outputUrl ?? null);
    const preflight = c.preflight;
    const queriedRights = preflight?.queriedRights ?? [];
    const queriedFacts = preflight?.queriedFacts ?? [];
    const passport = db.passports.find((p) => p.id === c.passportId) ?? null;
    const facts = db.productFacts.find((f) => f.id === c.productFactsId) ?? null;
    return {
      id: c.id,
      title: c.title,
      status: c.status,
      effectiveStatus: effectiveCampaignStatus(c),
      stage: productionStage(c),
      platform: c.request.platform,
      country: c.request.country,
      brand: c.brand,
      productName: c.productName,
      creatorId: c.creatorId,
      creatorName: creatorNames.get(c.creatorId) ?? c.creatorId,
      contextNote: c.contextNote,
      updatedAt: c.updatedAt,
      thumbnailUrl,
      generatedUrl: latestReceipt?.outputUrl ?? null,
      generatedMediaType: latestReceipt?.mediaType ?? null,
      receiptsCount: c.receipts.length,
      campaignUAL: c.campaignUAL ?? null,
      recordPublicationStatus: c.publicationStatus ?? null,
      verificationRef: c.verificationRef ?? null,
      activeJobs: c.jobs.filter((j) => isActiveJobStatus(j.status)).length,
      spentUsd: rollup.spent,
      estimatedUsd: preflight ? estimateCost(preflight) : 0,
      preflight: {
        decision: preflight ? preflight.decision : "pending",
        checkedAt: preflight?.checkedAt ?? null,
        blockerCount: preflight?.blockers.length ?? 0,
        blockers: (preflight?.blockers ?? []).map((b) => ({
          code: b.code,
          message: b.message,
          evidenceRefs: b.evidenceRefs
        })),
        allowedClaims: preflight?.allowedClaims ?? [],
        knowledgeAssetsConsulted: new Set([...queriedRights, ...queriedFacts]).size,
        queriedRights,
        queriedFacts
      },
      rights: passport
        ? {
            passportId: passport.id,
            platforms: passport.platforms,
            countries: passport.countries,
            validUntil: passport.validUntil,
            transformations: passport.allowedTransformations,
            status: passport.status,
            ual: passport.ual ?? null
          }
        : null,
      facts: facts
        ? { id: facts.id, approvedClaims: facts.approvedClaims, ual: facts.ual ?? null }
        : null
    };
  };

  const campaigns: OverviewCampaign[] = visible.map((c) => toOverviewCampaign(c));
  const archivedCampaigns: OverviewCampaign[] = db.campaigns
    .filter((c) => c.status === "archived")
    .map((c) => toOverviewCampaign(c));

  let totalSpent = 0;
  let totalOutputs = 0;
  let spendProtected = 0;
  const blockedIds: string[] = [];
  const readyIds: string[] = [];
  const pipelineBuckets = new Map<ProductionStage, string[]>();
  for (const row of campaigns) {
    totalSpent += row.spentUsd;
    totalOutputs += row.receiptsCount;
    if (row.effectiveStatus === "blocked") {
      blockedIds.push(row.id);
      spendProtected += row.estimatedUsd;
    }
    if (row.stage === "ready") readyIds.push(row.id);
    const bucket = pipelineBuckets.get(row.stage) ?? [];
    bucket.push(row.id);
    pipelineBuckets.set(row.stage, bucket);
  }

  const pipeline: PipelineCount[] = (Object.keys(STAGE_LABELS) as ProductionStage[]).map((stage) => ({
    stage,
    label: STAGE_LABELS[stage],
    count: pipelineBuckets.get(stage)?.length ?? 0,
    campaignIds: pipelineBuckets.get(stage) ?? []
  }));

  const activity: OverviewActivityItem[] = [...db.events]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, ACTIVITY_LIMIT)
    .map((e) => {
      const campaignId = e.refs.find((r) => titleByCampaignId.has(r)) ?? null;
      return {
        id: e.id,
        at: e.at,
        kind: e.kind,
        summary: e.summary,
        campaignId,
        campaignTitle: campaignId ? (titleByCampaignId.get(campaignId) ?? null) : null
      };
    });

  return {
    workspaceName,
    campaigns,
    archivedCampaigns,
    warnings,
    totalSpent,
    totalOutputs,
    metrics: {
      needsAttention: blockedIds.length,
      readyToProduce: readyIds.length,
      outputsDelivered: totalOutputs,
      spendProtected,
      totalSpent,
      blockedIds,
      readyIds
    },
    pipeline,
    activity
  };
}
