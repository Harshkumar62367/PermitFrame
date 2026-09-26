import type { ProductionJob } from "./types";
import { loadDb, newId, nowIso, updateDb } from "./store";
import { requireCurrentSession } from "./auth";
import { revalidateCampaignAuthorization } from "./policy/authorization";
import { composeStagePrompt } from "./policy/engine";
import { requestMetaFor } from "./livepeer/pipeline";
import { loadCampaign, throwIfArchived } from "./campaign-lifecycle";
import { withCampaignLock } from "./livepeer/mutex";
import { writeWorkspace } from "./livepeer/run-store";

/**
 * Explicit derivatives: reviewer refinements (reviseStage) and the
 * "Create variations" action. Both create new jobs on the existing stage
 * and run them under exact-job scope, so the original stage is never
 * re-run and siblings sharing the stageId are never touched. Depends on
 * the lifecycle module for reads and guards - never on template
 * application or production.
 */

/** Reviewer refinement: regenerate one stage with new instructions. */
export async function reviseStage(
  id: string,
  stageId: string,
  instructions: string,
  sourceJobId?: string,
  requestKey?: string
): Promise<{ started: boolean; jobId?: string; workspaceId?: string; error?: string }> {
  const campaign = await loadCampaign(id);
  if (!campaign) return { started: false, error: "Campaign not found" };
  try {
    throwIfArchived(campaign, "revised");
  } catch (e) {
    return { started: false, error: e instanceof Error ? e.message : "Archived campaigns are read-only." };
  }
  const stage = campaign.preflight?.plan.find((s) => s.id === stageId);
  if (!stage) return { started: false, error: "Unknown stage" };

  const { workspaceId } = await requireCurrentSession();
  const key = requestKey?.trim() || undefined;
  const priorRequest = key ? campaign.jobs.find((job) => job.refinementRequestKey === key) : undefined;
  if (priorRequest) {
    if (priorRequest.stageId !== stageId) return { started: false, error: "Refinement request belongs to another stage." };
    return { started: true, jobId: priorRequest.id, workspaceId };
  }

  // The selected queue card owns the refinement source. Older callers that
  // send only a stage still use its newest completed output.
  const priorOutput = sourceJobId
    ? campaign.jobs.find((job) => job.id === sourceJobId && job.stageId === stageId && job.status === "ready_to_share")
    : [...campaign.jobs].reverse().find((job) => job.stageId === stageId && job.status === "ready_to_share");
  if (!priorOutput) return { started: false, error: "The selected output is no longer ready. Refresh the queue before refining." };
  const variationSourceUrl = priorOutput?.providerOutputUrl ?? priorOutput?.outputUrl;
  if (!variationSourceUrl) return { started: false, error: "The selected output has no usable source URL." };

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
    ...(key ? { refinementRequestKey: key } : {}),
    ...(variationSourceUrl ? { variationSourceUrl } : {})
  };
  let jobId = revised.id;
  await withCampaignLock(id, () => writeWorkspace(workspaceId, (d) => {
    const c = d.campaigns.find((x) => x.id === id);
    if (!c) return;
    const replay = key ? c.jobs.find((job) => job.refinementRequestKey === key) : undefined;
    if (replay) { jobId = replay.id; return; }
    c.jobs.push(revised);
    c.status = "generating";
    c.updatedAt = nowIso();
  }, { mirror: false }));
  return { started: true, jobId, workspaceId };
}

/**
 * Replace one measured aspect-ratio mismatch with a fresh, source-guided
 * render. The rejected receipt remains audit history, but is retired from
 * delivery/proof checks before the new exact-job run starts.
 */
export async function regenerateRatioMismatch(
  id: string,
  receiptId: string
): Promise<{ started: boolean; jobId?: string; runId?: string; error?: string }> {
  const campaign = await loadCampaign(id);
  if (!campaign) return { started: false, error: "Campaign not found" };
  try {
    throwIfArchived(campaign, "regenerated");
  } catch (e) {
    return { started: false, error: e instanceof Error ? e.message : "Archived campaigns are read-only." };
  }
  if (campaign.preflight?.decision !== "allow") {
    return { started: false, error: "Rights are not currently allowed - regeneration was refused before any spend." };
  }
  const { workspaceId } = await requireCurrentSession();
  const authorization = await revalidateCampaignAuthorization(campaign, await loadDb());
  if (!authorization.ok) return { started: false, error: authorization.error };
  const receipt = campaign.receipts.find((r) => r.id === receiptId);
  if (!receipt) return { started: false, error: "Output not found" };
  if (receipt.supersededAt) return { started: false, error: "This ratio-mismatched output has already been replaced." };
  if (receipt.aspectVerdict !== "mismatch") return { started: false, error: "Only a measured ratio mismatch can be regenerated from this action." };
  const sourceJob = campaign.jobs.find((j) => j.id === receipt.jobId);
  const stage = sourceJob ? campaign.preflight?.plan.find((s) => s.id === sourceJob.stageId) : undefined;
  if (!sourceJob || !stage) return { started: false, error: "The original stage is no longer available - nothing was started." };

  const regenerated: ProductionJob = {
    id: newId("job"),
    campaignId: id,
    stageId: stage.id,
    kind: stage.kind,
    capability: stage.capability,
    requestedCapability: stage.capability,
    qualityProfile: stage.qualityProfile,
    role: stage.role,
    prompt: composeStagePrompt(campaign, stage.id),
    requestMeta: requestMetaFor(stage),
    status: "queued",
    startedAt: nowIso()
  };
  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === id);
    const stale = c?.receipts.find((r) => r.id === receiptId);
    if (!c || !stale || stale.aspectVerdict !== "mismatch" || stale.supersededAt) return;
    stale.supersededAt = nowIso();
    stale.supersededByJobId = regenerated.id;
    c.jobs.push(regenerated);
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "production.start",
      summary: `Ratio-mismatched output ${receiptId} was replaced by a fresh generation for stage "${stage.label}". The rejected output remains audit history and is excluded from delivery.`,
      refs: [id, receiptId, regenerated.id]
    });
  });
  const { submitRun, pumpRun } = await import("./livepeer/runner");
  const submitted = await submitRun({ campaignId: id, jobIds: [regenerated.id], workspaceId });
  if (!submitted.run) return { started: false, error: submitted.error ?? "Regeneration could not start" };
  void pumpRun(workspaceId, id, { runId: submitted.run.id, budgetMs: 8 * 60 * 1000 }).catch(() => undefined);
  return { started: true, jobId: regenerated.id, runId: submitted.run.id };
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

/** Complete the acknowledged refinement after the HTTP response. */
export async function startRefinementJob(
  workspaceId: string,
  campaignId: string,
  jobId: string,
  requestKey?: string
): Promise<void> {
  const { submitRun, pumpRun } = await import("./livepeer/runner");
  const submitted = await submitRun({ campaignId, jobIds: [jobId], idempotencyKey: requestKey, workspaceId });
  if (!submitted.run) {
    await withCampaignLock(campaignId, () => writeWorkspace(workspaceId, (d) => {
      const job = d.campaigns.find((c) => c.id === campaignId)?.jobs.find((j) => j.id === jobId);
      if (!job || job.status !== "queued") return;
      job.status = "failed";
      job.error = submitted.error ?? "Refinement could not enter the generation queue.";
      job.finishedAt = nowIso();
    }, { mirror: false }));
    return;
  }
  await pumpRun(workspaceId, campaignId, { runId: submitted.run.id, budgetMs: 8 * 60 * 1000 });
}
