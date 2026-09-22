import type { ProductionJob } from "./types";
import { newId, nowIso, updateDb } from "./store";
import { requireCurrentSession } from "./auth";
import { composeStagePrompt } from "./policy/engine";
import { requestMetaFor } from "./livepeer/pipeline";
import { loadCampaign, throwIfArchived } from "./campaign-lifecycle";

/**
 * Explicit derivatives: reviewer refinements (reviseStage) and the
 * "Create variations" action. Both create new jobs on the existing stage
 * and run them under exact-job scope, so the original stage is never
 * re-run and siblings sharing the stageId are never touched. Depends on
 * the lifecycle module for reads and guards - never on template
 * application or production.
 */

/** Reviewer refinement: regenerate one stage with new instructions. */
export async function reviseStage(id: string, stageId: string, instructions: string): Promise<{ started: boolean; error?: string }> {
  const campaign = await loadCampaign(id);
  if (!campaign) return { started: false, error: "Campaign not found" };
  try {
    throwIfArchived(campaign, "revised");
  } catch (e) {
    return { started: false, error: e instanceof Error ? e.message : "Archived campaigns are read-only." };
  }
  const stage = campaign.preflight?.plan.find((s) => s.id === stageId);
  if (!stage) return { started: false, error: "Unknown stage" };

  // Refinements vary the latest usable output when one exists (controlled
  // alternative via create_variations); otherwise they generate normally.
  const priorOutput = [...campaign.jobs]
    .reverse()
    .find((j) => j.stageId === stageId && (j.providerOutputUrl ?? j.outputUrl));
  const variationSourceUrl = priorOutput?.providerOutputUrl ?? priorOutput?.outputUrl;

  const revised: ProductionJob = {
    id: newId("job"),
    campaignId: id,
    stageId,
    kind: stage.kind,
    capability: stage.capability,
    requestedCapability: stage.capability,
    qualityProfile: stage.qualityProfile,
    role: stage.role,
    prompt: `${composeStagePrompt(campaign, stageId)} Reviewer refinement: ${instructions.trim()}`,
    requestMeta: requestMetaFor(stage),
    status: "queued",
    startedAt: nowIso(),
    // Explicit refinement: dispatch may vary the selected output via
    // create_variations. Set only here (and the variations action) - never
    // on initial production, so automatic variation is impossible.
    variationExplicit: true,
    ...(variationSourceUrl ? { variationSourceUrl } : {})
  };
  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === id);
    if (c) c.jobs.push(revised);
  });
  const { workspaceId } = await requireCurrentSession();
  void runSingleJob(id, revised.id, workspaceId).catch(() => undefined);
  return { started: true };
}

/**
 * Explicit "Create variations" action: derive additional assets from one
 * selected COMPLETED image output (ready_to_share only). The original stays
 * intact; each variation is a separate derivative job with its own spend.
 * Never runs automatically - this function is the only entry point besides
 * reviseStage, and both require a user action on a finished asset.
 */
export async function createVariationRun(
  id: string,
  receiptId: string,
  count = 2
): Promise<{ started: boolean; jobIds?: string[]; runId?: string; error?: string }> {
  const campaign = await loadCampaign(id);
  if (!campaign) return { started: false, error: "Campaign not found" };
  try {
    throwIfArchived(campaign, "varied");
  } catch (e) {
    return { started: false, error: e instanceof Error ? e.message : "Archived campaigns are read-only." };
  }
  if (campaign.preflight?.decision !== "allow") {
    return { started: false, error: "Rights are not currently allowed - variations are refused before any spend." };
  }
  const receipt = campaign.receipts.find((r) => r.id === receiptId);
  if (!receipt) return { started: false, error: "Output not found" };
  if (receipt.mediaType !== "image") return { started: false, error: "Variations are available for images only." };
  const sourceJob = campaign.jobs.find((j) => j.id === receipt.jobId);
  if (!sourceJob || sourceJob.status !== "ready_to_share") {
    return { started: false, error: "Variations start from a completed stored output - this one is not ready yet." };
  }
  const stage = campaign.preflight?.plan.find((s) => s.id === sourceJob.stageId);
  if (!stage) return { started: false, error: "Unknown stage" };
  if (stage.kind !== "image-to-image" && stage.kind !== "text-to-image") {
    return { started: false, error: "Variations are not supported for this stage kind." };
  }
  const variationSourceUrl = sourceJob.providerOutputUrl ?? sourceJob.outputUrl;
  if (!variationSourceUrl || !/^https:\/\//i.test(variationSourceUrl)) {
    return { started: false, error: "The selected output has no usable source URL - nothing was started." };
  }
  const safeCount = Math.min(Math.max(Math.trunc(count) || 1, 1), 4);
  const jobs: ProductionJob[] = [];
  for (let i = 0; i < safeCount; i++) {
    jobs.push({
      id: newId("job"),
      campaignId: id,
      stageId: stage.id,
      kind: stage.kind,
      capability: stage.capability,
      requestedCapability: stage.capability,
      qualityProfile: stage.qualityProfile,
      role: stage.role,
      prompt: `${composeStagePrompt(campaign, stage.id)} Explicit variation ${i + 1} of ${safeCount} from the selected completed output: keep the subject and product recognizable, vary composition and light.`,
      requestMeta: {
        ...requestMetaFor(stage),
        preservationRequested: "variation"
      },
      status: "queued",
      startedAt: nowIso(),
      variationExplicit: true,
      variationSourceUrl
    });
  }
  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === id);
    if (c) c.jobs.push(...jobs);
  });
  const { workspaceId } = await requireCurrentSession();
  // One exact-job run for all derivatives: progress reads 2/2, the ledger
  // carries one entry per derivative job, and cancellation addresses only
  // these ids. The original stage is never re-run; each derivative keeps
  // its own idempotency key and provider call.
  const { submitRun, pumpRun } = await import("./livepeer/runner");
  const submitted = await submitRun({ campaignId: id, jobIds: jobs.map((j) => j.id), workspaceId });
  if (!submitted.run) return { started: false, error: submitted.error ?? "Variation run submission failed" };
  void pumpRun(workspaceId, id, { runId: submitted.run.id, budgetMs: 8 * 60 * 1000 }).catch(() => undefined);
  return { started: true, jobIds: jobs.map((j) => j.id), runId: submitted.run.id };
}

async function runSingleJob(campaignId: string, jobId: string, workspaceId?: string): Promise<string | undefined> {
  // Exact-job run: only the target job dispatches, is polled, and settles -
  // siblings sharing its stageId are never selected, reset, failed, or
  // counted merely for sharing it (no more stage-filtered re-runs).
  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === campaignId);
    if (!c) return;
    const target = c.jobs.find((j) => j.id === jobId);
    if (target) target.status = "queued";
    c.status = "generating";
  });
  const { submitRun, pumpRun } = await import("./livepeer/runner");
  const submitted = await submitRun({ campaignId, jobIds: [jobId], workspaceId }).catch(
    (): { run?: undefined; created: boolean; workspaceId?: string } => ({ created: false })
  );
  if (!submitted.run) return undefined;
  void pumpRun(submitted.workspaceId ?? workspaceId ?? "", campaignId, { runId: submitted.run.id, budgetMs: 8 * 60 * 1000 }).catch(() => undefined);
  return submitted.run.id;
}
