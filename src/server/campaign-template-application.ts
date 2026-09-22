import type { Campaign, ProductionJob } from "./types";
import { newId, nowIso, updateDb } from "./store";
import { checkProfileAccess, resolveEntitlements } from "./entitlements";
import { getTemplate, validateTemplateSelection, type TemplateSelection } from "./livepeer/templates";
import { loadCampaign, rePreflight, throwIfArchived } from "./campaign-lifecycle";

/**
 * Template application: spec validation, production-spec persistence, plan
 * rebuild through the normal preflight path, and history safety. Depends
 * on the lifecycle module for reads, guards, and re-checks - never on
 * production or variations.
 */

/**
 * States where a job may already be handed to Livepeer (or about to be).
 * Template apply never prunes or alters these - a `generating` row with no
 * output URL can still be rendering remotely, and a `queued` row cannot be
 * proven undispatched (dispatch is not separately persisted), so queued
 * rows are never pruned either.
 */
export const ACTIVE_JOB_STATUSES: ProductionJob["status"][] = [
  "queued",
  "generating",
  "preview_ready",
  "storage_pending"
];

/**
 * Pure readiness gate for template apply: refuse while any active job
 * exists. Tested directly; applyTemplateSpec enforces it before touching
 * anything.
 */
export function checkTemplateApplyReadiness(campaign: Pick<Campaign, "jobs">): string | null {
  const active = campaign.jobs.filter((j) => (ACTIVE_JOB_STATUSES as string[]).includes(j.status));
  if (active.length > 0) {
    return "Wait for active generation to finish or fail before changing the production template.";
  }
  return null;
}

/**
 * Apply a template-driven production spec, then rebuild the plan through
 * the normal preflight path (rights are re-checked; a re-block keeps
 * generation locked). Only allow-verdict campaigns may apply a template -
 * blocked campaigns never reach generation. Queued jobs for retired stages
 * are dropped (they never ran - nothing was spent); delivered, failed, and
 * preview history is kept.
 */
export async function applyTemplateSpec(id: string, raw: unknown): Promise<{ campaign?: Campaign; error?: string }> {
  const campaign = await loadCampaign(id);
  if (!campaign) return { error: "Campaign not found" };
  try {
    throwIfArchived(campaign, "re-planned");
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Archived campaigns are read-only." };
  }
  if (campaign.preflight?.decision !== "allow") {
    return { error: "Resolve the rights block before choosing a production template - blocked campaigns never reach generation." };
  }
  const tier = resolveEntitlements();
  const validated = validateTemplateSelection(raw, tier.maxCustomStages);
  if (!validated.ok || !validated.spec) return { error: validated.error ?? "Invalid template selection." };
  const spec: TemplateSelection = validated.spec;
  const template = getTemplate(spec.templateId);
  if (!template) return { error: `Unknown template "${spec.templateId}".` };
  const profileGate = checkProfileAccess(spec.qualityProfile, tier);
  if (profileGate) return { error: profileGate };
  // Active jobs may already be rendering at Livepeer - refuse rather than
  // orphan them. Delivered/failed/storage history is kept untouched.
  const readiness = checkTemplateApplyReadiness(campaign);
  if (readiness) return { error: readiness };

  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === id);
    if (!c) return;
    c.request.productionSpec = spec;
    c.request.qualityProfile = spec.qualityProfile;
    c.updatedAt = nowIso();
  });
  const rebuilt = await rePreflight(id);
  if (!rebuilt) return { error: "Campaign not found" };
  if (rebuilt.preflight?.decision !== "allow") {
    return { error: "Rights re-check blocked the campaign - fix the rights issue before producing." };
  }
  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === id);
    if (!c) return;
    c.updatedAt = nowIso();
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "template.apply",
      summary: `Production template "${template.title}" applied (${spec.packSize} pack). Prior outputs stay as history.`,
      refs: [id]
    });
  });
  const final = await loadCampaign(id);
  if (!final) return { error: "Campaign not found" };
  return { campaign: final };
}
