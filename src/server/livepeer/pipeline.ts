import type { Campaign, DerivativeReceipt, ProductionJob } from "../types";
import { loadDb, newId, nowIso, sha256, updateDb } from "../store";
import { getDkg } from "../dkg";
import { receiptKa, campaignKa } from "../dkg/schemas";
import { composeStagePrompt } from "../policy/engine";
import { LivepeerMcpClient, livepeerConfig } from "./mcp-client";

/**
 * Executes the permitted production plan through the Livepeer Agent MCP,
 * stage by stage, recording evidence for every job and publishing a
 * Derivative Receipt Knowledge Asset for each output.
 */

export interface StageOutcome {
  stageId: string;
  jobId: string;
  status: ProductionJob["status"];
  outputUrl?: string;
  error?: string;
  humanSummary?: string;
}

export function createJobRecords(campaign: Campaign): ProductionJob[] {
  const plan = campaign.preflight?.plan ?? [];
  return plan.map((stage) => ({
    id: newId("job"),
    campaignId: campaign.id,
    stageId: stage.id,
    kind: stage.kind,
    capability: stage.capability,
    prompt: composeStagePrompt(campaign, stage.id),
    status: "queued",
    startedAt: nowIso()
  }));
}

export async function runProduction(campaignId: string): Promise<{ finished: boolean; error?: string }> {
  const db = await loadDb();
  const campaign = db.campaigns.find((c) => c.id === campaignId);
  if (!campaign) return { finished: true, error: "Campaign not found" };
  if (campaign.preflight?.decision !== "allow") {
    return { finished: true, error: "Production blocked by policy preflight" };
  }

  const client = new LivepeerMcpClient(livepeerConfig());
  const sourceMedia = db.sourceMedia.find((m) => m.id === campaign.sourceMediaId);
  let previousOutputUrl: string | undefined = sourceMedia?.url;
  let anyFailure = false;

  for (const job of campaign.jobs) {
    if (job.status === "succeeded") {
      previousOutputUrl = job.outputUrl ?? previousOutputUrl;
      continue;
    }
    if (anyFailure) break; // a failed stage halts dependent stages

    await updateDb((d) => {
      const c = d.campaigns.find((x) => x.id === campaignId);
      const j = c?.jobs.find((x) => x.id === job.id);
      if (c) c.status = "generating";
      if (j) {
        j.status = "running";
        j.startedAt = nowIso();
      }
    });

    try {
      const stage = campaign.preflight?.plan.find((s) => s.id === job.stageId);
      const isVideo = job.kind === "image-to-video";
      const baseInput = {
        prompt: job.prompt,
        sourceUrl: previousOutputUrl,
        inputs: stage
          ? stage.format === "1:1"
            ? { aspect_ratio: "1:1" }
            : stage.format === "16:9"
              ? { aspect_ratio: "16:9" }
              : { aspect_ratio: "9:16", ...(isVideo ? { duration: 5 } : {}) }
          : undefined,
        timeoutSeconds: isVideo ? 600 : 90,
        sessionId: campaign.id,
        idempotencyKey: `pf_${campaign.id}_${job.stageId}_${job.id}`
      };

      // The raw surface never substitutes capabilities; when a capability is
      // disabled the error names the recommended replacement — retry once with it.
      let result;
      try {
        result = await client.runCapability({ capability: job.capability, ...baseInput });
      } catch (firstError) {
        const replacement = (firstError as Error).message.match(/recommended replacement is ([a-z0-9-]+)/i);
        if (!replacement) throw firstError;
        result = await client.runCapability({ capability: replacement[1], ...baseInput });
        await updateDb((d) => {
          const c = d.campaigns.find((x) => x.id === campaignId);
          const j = c?.jobs.find((x) => x.id === job.id);
          if (j) j.capability = `${j.capability} → ${replacement[1]} (auto-recovered)`;
        });
      }

      if (!result.outputUrl) throw new Error("Generation completed without an output URL.");
      previousOutputUrl = result.outputUrl;

      await updateDb((d) => {
        const c = d.campaigns.find((x) => x.id === campaignId);
        const j = c?.jobs.find((x) => x.id === job.id);
        if (j) {
          j.status = "succeeded";
          j.outputUrl = result.outputUrl;
          j.outputHash = sha256(result.outputUrl!);
          j.finishedAt = nowIso();
          j.livepeerJobId = result.jobId;
          j.humanSummary = result.humanSummary;
          j.costUsd = result.costUsd;
        }
      });

      await publishReceipt(campaignId, job.id, result.outputUrl, result.capability ?? job.capability);
    } catch (error) {
      anyFailure = true;
      await updateDb((d) => {
        const c = d.campaigns.find((x) => x.id === campaignId);
        const j = c?.jobs.find((x) => x.id === job.id);
        if (c) c.status = "review";
        if (j) {
          j.status = "failed";
          j.error = (error as Error).message.slice(0, 400);
          j.finishedAt = nowIso();
        }
      });
    }
  }

  const finalDb = await loadDb();
  const finalCampaign = finalDb.campaigns.find((c) => c.id === campaignId);
  const succeeded = finalCampaign?.jobs.filter((j) => j.status === "succeeded").length ?? 0;
  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === campaignId);
    if (c) {
      c.status = anyFailure && succeeded === 0 ? "blocked" : "review";
      c.updatedAt = nowIso();
    }
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "production.run",
      summary: `Production run finished: ${succeeded}/${finalCampaign?.jobs.length ?? 0} stages succeeded.`,
      refs: [campaignId]
    });
  });
  return { finished: true };
}

async function publishReceipt(
  campaignId: string,
  jobId: string,
  outputUrl: string,
  capability: string
): Promise<void> {
  const db = await loadDb();
  const campaign = db.campaigns.find((c) => c.id === campaignId);
  const job = campaign?.jobs.find((j) => j.id === jobId);
  if (!campaign || !job) return;

  const receipt: DerivativeReceipt = {
    id: newId("rcpt"),
    campaignId,
    jobId,
    label: campaign.preflight?.plan.find((s) => s.id === job.stageId)?.label ?? job.stageId,
    mediaType: job.kind === "image-to-video" ? "video" : "image",
    format: campaign.preflight?.plan.find((s) => s.id === job.stageId)?.format ?? "9:16",
    outputUrl,
    outputHash: sha256(outputUrl),
    capability,
    promptHash: sha256(job.prompt),
    claimsUsed: campaign.preflight?.allowedClaims ?? [],
    derivedFrom: {
      sourceMediaId: campaign.sourceMediaId,
      passportId: campaign.passportId,
      productFactsId: campaign.productFactsId
    },
    generatedAt: nowIso(),
    costUsd: job.costUsd,
    visibility: "shared"
  };

  try {
    const dkg = getDkg();
    const record = await dkg.publish(receiptKa(receipt), receipt.visibility);
    receipt.ual = record.ual;
    receipt.ualExplorer = record.explorerUrl;
  } catch {
    // keep the receipt locally even if publication fails; the UI will show it unpublished
  }

  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === campaignId);
    if (c) c.receipts.push(receipt);
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "dkg.publish",
      summary: `Derivative receipt ${receipt.ual ?? receipt.id} published for stage "${receipt.label}".`,
      refs: [campaignId, receipt.id]
    });
  });
}

export async function publishCampaignRecord(campaignId: string): Promise<string | undefined> {
  const db = await loadDb();
  const campaign = db.campaigns.find((c) => c.id === campaignId);
  if (!campaign) return undefined;
  try {
    const record = await getDkg().publish(campaignKa(campaign), "shared");
    await updateDb((d) => {
      const c = d.campaigns.find((x) => x.id === campaignId);
      if (c) c.campaignUAL = record.ual;
    });
    return record.ual;
  } catch {
    return undefined;
  }
}
