import "server-only";
import type { Campaign, CampaignStatus } from "./types";
import { isActiveJobStatus } from "./types";
import { newId, nowIso, updateDb } from "./store";

export type ProductionStage = "briefed" | "policy-check" | "ready" | "generating" | "delivered";

export const PRODUCTION_STAGES: { stage: ProductionStage; label: string }[] = [
  { stage: "briefed", label: "Briefed" },
  { stage: "policy-check", label: "Policy check" },
  { stage: "ready", label: "Ready" },
  { stage: "generating", label: "Generating" },
  { stage: "delivered", label: "Delivered" }
];

/**
 * Single source of truth for "is this campaign blocked?".
 *
 * The stored `campaign.status` is written at create/re-preflight time and can
 * drift from the live preflight verdict (legacy rows, production failures that
 * reused the "blocked" label, revocation races). The preflight decision is the
 * authority: it is what actually gates Livepeer spend in startProduction and
 * what the campaign detail verdict renders. Every KPI, badge, cost rollup and
 * overview row must derive from this function — never from `status` alone.
 */
export function effectiveCampaignStatus(
  campaign: Pick<Campaign, "status" | "preflight">
): CampaignStatus {
  // Archived is terminal and read-only: the live verdict must never rewrite it.
  if (campaign.status === "archived") return "archived";
  const decision = campaign.preflight?.decision;
  if (decision === "block") return "blocked";
  // A stored "blocked" whose preflight now allows (or never ran) is stale:
  // surface the stored workflow state instead of a phantom block.
  if (decision === "allow" && campaign.status === "blocked") return "draft";
  return campaign.status;
}

/**
 * Operational production stage derived from real workflow fields
 * (preflight, jobs, receipts, status). Read-only summary — the pipeline UI
 * must never imply drag-and-drop state movement.
 */
export function productionStage(campaign: Campaign): ProductionStage {
  const active = campaign.jobs.some((j) => isActiveJobStatus(j.status));
  if (active || campaign.status === "generating") return "generating";
  if (campaign.receipts.length > 0 || campaign.status === "approved" || campaign.status === "review") {
    return "delivered";
  }
  if (!campaign.preflight) return "briefed";
  if (campaign.preflight.decision === "block") return "policy-check";
  return "ready";
}

/**
 * Self-healing repair: persist the effective status when the stored row has
 * drifted. Called from workspace reads (overview, snapshot, campaign detail)
 * so legacy rows converge to the truth without a manual migration. Returns
 * true only when a write actually happened.
 */
export async function reconcileCampaignStatus(campaign: Campaign): Promise<boolean> {
  // Archived rows are history, not drift — never rewrite them.
  if (campaign.status === "archived") return false;
  const effective = effectiveCampaignStatus(campaign);
  if (effective === campaign.status) return false;
  await updateDb((d) => {
    const target = d.campaigns.find((x) => x.id === campaign.id);
    if (target) {
      target.status = effective;
      target.updatedAt = nowIso();
    }
  });
  campaign.status = effective;
  campaign.updatedAt = nowIso();
  return true;
}

/** Audit event for a preflight verdict — the defensibility record. Real data only. */
export function preflightEvent(
  campaign: Pick<Campaign, "id" | "title">,
  decision: Pick<NonNullable<Campaign["preflight"]>, "decision" | "blockers">
): { id: string; at: string; kind: string; summary: string; refs: string[] } {
  if (decision.decision === "block") {
    return {
      id: newId("evt"),
      at: nowIso(),
      kind: "preflight.block",
      summary: `Changes needed before creation: "${campaign.title}" — ${decision.blockers.length} reason${decision.blockers.length === 1 ? "" : "s"}, no production spend.`,
      refs: [campaign.id]
    };
  }
  return {
    id: newId("evt"),
    at: nowIso(),
    kind: "preflight.allow",
    summary: `Approved to create: "${campaign.title}" — creator permissions and brand rules allow this campaign.`,
    refs: [campaign.id]
  };
}
