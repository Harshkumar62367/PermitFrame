import { requireCurrentSession } from "./auth";
import { loadCampaign, throwIfArchived } from "./campaign-lifecycle";

/**
 * Production handoff: submit stage/DAG-scoped runs and cancel queued or
 * in-flight jobs through the Livepeer runner. Session resolution and the
 * archived gate live here; spend caps, entitlement gates, idempotency, and
 * execution stay in the runner. Depends on the lifecycle module for reads
 * and guards - never on template application or variations.
 */

/** Kick off production: durable records are created synchronously and the request returns fast with a run id; the dependency-aware pump executes in the background (bounded concurrency) and any later request resumes it. */
export async function startProduction(
  id: string,
  capabilityOverride?: string,
  stageIds?: string[],
  idempotencyKey?: string,
  jobIds?: string[],
  retryMode?: "same" | "backup",
  confirmUnknownSpend?: boolean
): Promise<{ started: boolean; runId?: string; error?: string }> {
  const campaign = await loadCampaign(id);
  if (!campaign) return { started: false, error: "Campaign not found" };
  try {
    throwIfArchived(campaign, "produced");
  } catch (e) {
    return { started: false, error: e instanceof Error ? e.message : "Archived campaigns are read-only." };
  }
  // workspaceId is resolved here (request context) because the pump below outlives the response.
  let workspaceId: string;
  try {
    workspaceId = (await requireCurrentSession()).workspaceId;
  } catch {
    return { started: false, error: "Authentication required" };
  }
  const { submitRun, pumpRun } = await import("./livepeer/runner");
  const submitted = await submitRun({
    campaignId: id,
    stageIds,
    capabilityOverride,
    idempotencyKey,
    jobIds,
    retryMode,
    confirmUnknownSpend,
    workspaceId
  });
  if (!submitted.run) return { started: false, error: submitted.error ?? "Run submission failed" };
  void pumpRun(workspaceId, id, { runId: submitted.run.id, budgetMs: 8 * 60 * 1000 }).catch(() => undefined);
  return { started: true, runId: submitted.run.id };
}

/** Cancel queued/in-flight jobs. Provider confirmation gates provider-side claims. */
export async function cancelCampaignJobs(
  id: string,
  jobIds?: string[]
): Promise<{ results: import("./livepeer/runner").CancelResult[]; error?: string }> {
  const campaign = await loadCampaign(id);
  if (!campaign) return { results: [], error: "Campaign not found" };
  try {
    throwIfArchived(campaign, "cancelled in");
  } catch (e) {
    return { results: [], error: e instanceof Error ? e.message : "Archived campaigns are read-only." };
  }
  const { workspaceId } = await requireCurrentSession();
  const { cancelRunJobs } = await import("./livepeer/runner");
  const results = await cancelRunJobs(workspaceId, id, jobIds);
  return { results };
}
