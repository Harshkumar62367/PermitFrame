import type { Campaign, CampaignRequest, ProductionJob } from "./types";
import { loadDb, newId, nowIso, updateDb } from "./store";
import { preflight, composeStagePrompt } from "./policy/engine";
import { createJobRecords, publishCampaignRecord, runProduction } from "./livepeer/pipeline";

export async function loadCampaign(id: string): Promise<Campaign | undefined> {
  return (await loadDb()).campaigns.find((c) => c.id === id);
}

export async function createCampaign(input: {
  title: string;
  brand: string;
  productName: string;
  creatorId: string;
  sourceMediaId: string;
  passportId: string;
  productFactsId: string;
  request: CampaignRequest;
  demoNote?: string;
}): Promise<Campaign> {
  const campaign: Campaign = {
    id: newId("cmp"),
    title: input.title,
    brand: input.brand,
    productName: input.productName,
    request: input.request,
    status: "draft",
    jobs: [],
    receipts: [],
    comments: [],
    captions: [],
    creatorId: input.creatorId,
    sourceMediaId: input.sourceMediaId,
    passportId: input.passportId,
    productFactsId: input.productFactsId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    demoNote: input.demoNote
  };
  campaign.preflight = await preflight(campaign);
  if (campaign.preflight.decision === "block") campaign.status = "blocked";
  await updateDb((d) => d.campaigns.push(campaign));
  return campaign;
}

/** Re-check an existing campaign against the current graph (rights may have changed). */
export async function rePreflight(id: string): Promise<Campaign | undefined> {
  const campaign = await loadCampaign(id);
  if (!campaign) return undefined;
  campaign.preflight = await preflight(campaign);
  campaign.status = campaign.preflight.decision === "block" ? "blocked" : campaign.status === "blocked" ? "draft" : campaign.status;
  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === id);
    if (c) {
      c.preflight = campaign.preflight;
      c.status = campaign.status;
      c.updatedAt = nowIso();
    }
  });
  return loadCampaign(id);
}

/** Kick off production: job records are created synchronously, execution runs in background. */
export async function startProduction(id: string, capabilityOverride?: string): Promise<{ started: boolean; error?: string }> {
  const campaign = await loadCampaign(id);
  if (!campaign) return { started: false, error: "Campaign not found" };
  if (campaign.preflight?.decision !== "allow") return { started: false, error: "Preflight has not approved this campaign" };

  if (campaign.jobs.length > 0) {
    // resume: keep succeeded stages, reset failed/queued ones
    await updateDb((d) => {
      const c = d.campaigns.find((x) => x.id === id);
      if (c) {
        for (const j of c.jobs) {
          if (j.status === "failed") {
            if (capabilityOverride?.trim()) j.capability = capabilityOverride.trim();
            j.status = "queued";
            j.error = undefined;
          }
        }
        c.status = "generating";
        c.updatedAt = nowIso();
      }
    });
  } else {
    const jobs = createJobRecords(campaign);
    await updateDb((d) => {
      const c = d.campaigns.find((x) => x.id === id);
      if (c) {
        c.jobs = jobs;
        c.status = "generating";
        c.updatedAt = nowIso();
      }
    });
  }
  // background execution; UI polls GET /api/campaigns/[id] for progress
  void runProduction(id).catch(() => undefined);
  return { started: true };
}

/** Reviewer refinement: regenerate one stage with new instructions. */
export async function reviseStage(id: string, stageId: string, instructions: string): Promise<{ started: boolean; error?: string }> {
  const campaign = await loadCampaign(id);
  if (!campaign) return { started: false, error: "Campaign not found" };
  const stage = campaign.preflight?.plan.find((s) => s.id === stageId);
  if (!stage) return { started: false, error: "Unknown stage" };

  const revised: ProductionJob = {
    id: newId("job"),
    campaignId: id,
    stageId,
    kind: stage.kind,
    capability: stage.capability,
    prompt: `${composeStagePrompt(campaign, stageId)} Reviewer refinement: ${instructions.trim()}`,
    status: "queued",
    startedAt: nowIso()
  };
  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === id);
    if (c) c.jobs.push(revised);
  });
  void runSingleJob(id, revised.id).catch(() => undefined);
  return { started: true };
}

async function runSingleJob(campaignId: string, jobId: string): Promise<void> {
  // Reuse the pipeline by marking only the target job as pending work
  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === campaignId);
    if (!c) return;
    for (const j of c.jobs) {
      if (j.id !== jobId && j.status === "queued") j.status = "succeeded"; // skip others
      if (j.id === jobId) j.status = "queued";
    }
    c.status = "generating";
  });
  // runProduction skips succeeded jobs and executes the queued one
  await runProduction(campaignId);
}

export async function approveCampaign(id: string): Promise<{ approved: boolean; ual?: string; error?: string }> {
  const campaign = await loadCampaign(id);
  if (!campaign) return { approved: false, error: "Campaign not found" };
  if (campaign.status === "blocked") return { approved: false, error: "Blocked campaigns cannot be approved" };
  if (campaign.jobs.filter((j) => j.status === "succeeded").length === 0) {
    return { approved: false, error: "Produce the campaign pack before approving — there is nothing to sign off yet" };
  }
  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === id);
    if (c) {
      c.status = "approved";
      c.updatedAt = nowIso();
    }
  });
  const ual = await publishCampaignRecord(id);
  return { approved: true, ual };
}
