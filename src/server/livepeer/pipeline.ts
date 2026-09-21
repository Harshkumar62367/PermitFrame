import type { Campaign, DerivativeReceipt, ProductionJob, PublicationStatus } from "../types";
import { loadDb, newId, nowIso, sha256, updateDb } from "../store";
import { getDb } from "../db/client";
import { campaignAssets } from "../db/schema";
import { eq } from "drizzle-orm";
import { getDkg } from "../dkg";
import { receiptKa, campaignKa } from "../dkg/schemas";
import { composeStagePrompt } from "../policy/engine";
import { LivepeerMcpClient, livepeerConfig } from "./mcp-client";
import { assertCapabilityAvailable } from "./catalogue";
import { fetchLivePriceMap, stageSpendingCeiling } from "./pricing";
import { getCampaignAssets, persistJobAsset } from "../asset-store";
import { isCloudinaryConfigured } from "../cloudinary";

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

export function createJobRecords(campaign: Campaign, stageIds?: string[]): ProductionJob[] {
  const plan = campaign.preflight?.plan ?? [];
  const wanted = stageIds && stageIds.length > 0 ? new Set(stageIds) : null;
  return plan
    .filter((stage) => !wanted || wanted.has(stage.id))
    .map((stage) => ({
      id: newId("job"),
      campaignId: campaign.id,
      stageId: stage.id,
      kind: stage.kind,
      capability: stage.capability,
      prompt: composeStagePrompt(campaign, stage.id),
      requestMeta: requestMetaFor(stage),
      status: "queued",
      startedAt: nowIso()
    }));
}

/** Storage-safe description of what a stage asks the provider for. */
export function requestMetaFor(stage: { kind: string; format: string }): NonNullable<ProductionJob["requestMeta"]> {
  return {
    aspectRatio: stage.format,
    ...(stage.kind === "image-to-video" ? { durationSeconds: 5 } : {})
  };
}

/** Storage worker for one previewed job. Compare-and-set on preview_ready
 * makes double polls harmless: only the first worker proceeds. */
async function persistPreviewInBackground(input: {
  workspaceId: string;
  campaignId: string;
  jobId: string;
  providerUrl: string;
  promptHash: string;
  providerModel: string;
  livepeerJobId?: string;
  costUsd?: number;
  kind: ProductionJob["kind"];
}): Promise<void> {
  if (!isCloudinaryConfigured()) {
    // Legacy delivery: durable storage unavailable, so the preview itself
    // delivers (labeled provider-hosted downstream).
    const delivered = await transitionJob(input.campaignId, input.jobId, "preview_ready", "ready_to_share");
    if (delivered) {
      await updateDb((d) => {
        const j = d.campaigns.find((x) => x.id === input.campaignId)?.jobs.find((x) => x.id === input.jobId);
        if (j) j.finishedAt = nowIso();
      });
      await publishReceipt(input.campaignId, input.jobId, input.providerUrl, input.providerModel, null);
    }
    return;
  }
  const claimed = await transitionJob(input.campaignId, input.jobId, "preview_ready", "storage_pending");
  if (!claimed) return;
  const outcome = await persistJobAsset({
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    job: {
      id: input.jobId,
      kind: input.kind,
      capability: input.providerModel,
      providerOutputUrl: input.providerUrl,
      livepeerJobId: input.livepeerJobId,
      costUsd: input.costUsd
    },
    promptHash: input.promptHash,
    providerModel: input.providerModel
  });
  if (outcome.outcome === "stored") {
    const canonicalUrl = outcome.asset.secureUrl;
    await updateDb((d) => {
      const j = d.campaigns.find((x) => x.id === input.campaignId)?.jobs.find((x) => x.id === input.jobId);
      if (j) {
        j.status = "ready_to_share";
        j.outputUrl = canonicalUrl;
        j.finishedAt = nowIso();
      }
    });
    const receiptId = await publishReceipt(input.campaignId, input.jobId, canonicalUrl, input.providerModel, {
      publicId: outcome.asset.publicId,
      url: canonicalUrl
    });
    if (receiptId) {
      await getDb()
        .update(campaignAssets)
        .set({ receiptId, updatedAt: new Date() })
        .where(eq(campaignAssets.jobId, input.jobId))
        .catch(() => undefined);
    }
    return;
  }
  if (outcome.outcome === "deferred") {
    await transitionJob(input.campaignId, input.jobId, "storage_pending", "preview_ready");
    return;
  }
  // Failed: preview intact, retryable within the attempt budget.
  await transitionJob(input.campaignId, input.jobId, "storage_pending", "storage_retry_needed");
}

/** Compare-and-set a job status. Returns true only when it transitioned. */
async function transitionJob(campaignId: string, jobId: string, from: ProductionJob["status"], to: ProductionJob["status"]): Promise<boolean> {
  let moved = false;
  await updateDb((d) => {
    const j = d.campaigns.find((x) => x.id === campaignId)?.jobs.find((x) => x.id === jobId);
    if (j && j.status === from) {
      j.status = to;
      moved = true;
    }
  });
  return moved;
}

export async function runProduction(campaignId: string, onlyStageIds?: string[], workspaceId?: string): Promise<{ finished: boolean; error?: string }> {
  const db = await loadDb();
  const campaign = db.campaigns.find((c) => c.id === campaignId);
  if (!campaign) return { finished: true, error: "Campaign not found" };
  if (campaign.preflight?.decision !== "allow") {
    return { finished: true, error: "Production blocked by policy preflight" };
  }

  const client = new LivepeerMcpClient(livepeerConfig());
  const sourceMedia = db.sourceMedia.find((m) => m.id === campaign.sourceMediaId);
  // Live pricing is best-effort (cached, never blocking): ceilings fall back
  // to historical prices when the agent is unreachable.
  const livePrices = await fetchLivePriceMap();
  let previousOutputUrl: string | undefined = sourceMedia?.url;
  let anyFailure = false;

  for (const job of campaign.jobs) {
    if (job.status === "ready_to_share") {
      previousOutputUrl = job.outputUrl ?? previousOutputUrl;
      continue;
    }
    // Stage-subset runs (studio deliverable selection, single-stage refine)
    // leave unselected jobs untouched — they are neither executed nor marked.
    if (onlyStageIds && !onlyStageIds.includes(job.stageId)) continue;
    if (anyFailure) break; // a failed stage halts dependent stages

    await updateDb((d) => {
      const c = d.campaigns.find((x) => x.id === campaignId);
      const j = c?.jobs.find((x) => x.id === job.id);
      if (c) c.status = "generating";
      if (j) {
        j.status = "generating";
        j.startedAt = nowIso();
        // Record what actually fed this run: the registered source, or a
        // prior stage output chained by the orchestrator.
        const fromPrior = previousOutputUrl !== undefined && previousOutputUrl !== sourceMedia?.url;
        j.requestMeta = { ...j.requestMeta, sourceKind: fromPrior ? "prior-output" : "source-media" };
      }
    });

    try {
      const stage = campaign.preflight?.plan.find((s) => s.id === job.stageId);
      const isVideo = job.kind === "image-to-video";
      // Refuse dispatch for models discovery does not list as available —
      // the job fails honestly instead of spending against a missing model.
      await assertCapabilityAvailable(job.capability);
      const baseInput = {
        capability: job.capability,
        kind: job.kind,
        prompt: job.prompt,
        sourceUrl: previousOutputUrl,
        maxCostUsd: stageSpendingCeiling(
          { capability: job.capability, kind: job.kind },
          livePrices,
          isVideo ? 5 : 0
        ),
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

      // The Creative surface substitutes or retires models; when an error
      // disabled the error names the recommended replacement — retry once with it.
      let result;
      try {
        result = await client.runCapability(baseInput);
      } catch (firstError) {
        const replacement = (firstError as Error).message.match(/recommended replacement is ([a-z0-9-]+)/i);
        if (!replacement) throw firstError;
        result = await client.runCapability({ ...baseInput, capability: replacement[1] });
        await updateDb((d) => {
          const c = d.campaigns.find((x) => x.id === campaignId);
          const j = c?.jobs.find((x) => x.id === job.id);
          if (j) j.capability = `${j.capability} → ${replacement[1]} (auto-recovered)`;
        });
      }

      if (!result.outputUrl) throw new Error("Generation completed without an output URL.");
      const providerUrl = result.outputUrl;
      previousOutputUrl = providerUrl;

      // Preview first: the genuine Livepeer output is visible immediately as
      // provider-hosted preview. Durable persistence runs detached below —
      // the loop, the API response, and navigation never wait for it.
      await updateDb((d) => {
        const c = d.campaigns.find((x) => x.id === campaignId);
        const j = c?.jobs.find((x) => x.id === job.id);
        if (j) {
          j.status = "preview_ready";
          j.providerOutputUrl = providerUrl;
          j.outputUrl = providerUrl;
          j.providerUrlFingerprint = sha256(providerUrl);
          j.livepeerJobId = result.jobId;
          j.humanSummary = result.humanSummary;
          j.costUsd = result.costUsd;
        }
      });

      if (workspaceId) {
        void persistPreviewInBackground({
          workspaceId,
          campaignId,
          jobId: job.id,
          providerUrl,
          promptHash: sha256(job.prompt),
          providerModel: result.capability ?? job.capability,
          livepeerJobId: result.jobId,
          costUsd: result.costUsd,
          kind: job.kind
        }).catch(() => undefined);
      }
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
  const succeeded = finalCampaign?.jobs.filter((j) => j.status === "ready_to_share").length ?? 0;
  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === campaignId);
    if (c) {
      // A failed generation run is a production outcome, never a policy
      // verdict: "blocked" is reserved for preflight denials (it gates spend
      // and drives the dashboard). Failed runs land in "review" so a human
      // inspects the job errors instead of seeing a phantom policy block.
      c.status = "review";
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
  capability: string,
  storage: { publicId: string; url: string } | null
): Promise<string> {
  const db = await loadDb();
  const campaign = db.campaigns.find((c) => c.id === campaignId);
  const job = campaign?.jobs.find((j) => j.id === jobId);
  if (!campaign || !job) return "";

  const receipt: DerivativeReceipt = {
    id: newId("rcpt"),
    campaignId,
    jobId,
    label: campaign.preflight?.plan.find((s) => s.id === job.stageId)?.label ?? job.stageId,
    mediaType: job.kind === "image-to-video" ? "video" : "image",
    format: campaign.preflight?.plan.find((s) => s.id === job.stageId)?.format ?? "9:16",
    outputUrl,
    // URL fingerprint for correlation only — never content evidence (see types).
    providerUrlFingerprint: job.providerUrlFingerprint ?? sha256(outputUrl),
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
    visibility: "shared",
    ...(storage
      ? {
          storageProvider: "cloudinary" as const,
          storagePublicId: storage.publicId,
          storageUrl: storage.url,
          storageStatus: "stored" as const
        }
      : {})
  };

  try {
    const dkg = getDkg();
    const record = await dkg.publish(receiptKa(receipt), receipt.visibility);
    receipt.ual = record.ual;
    receipt.ualExplorer = record.explorerUrl;
    receipt.publicationStatus = record.publicationStatus;
  } catch {
    // keep the receipt locally even if publication fails; the persisted
    // "failed" state makes the retry path honest.
    receipt.publicationStatus = "failed";
  }

  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === campaignId);
    if (c) c.receipts.push(receipt);
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "dkg.publish",
      summary: `Derivative receipt ${receipt.id} published for stage "${receipt.label}".`,
      refs: [campaignId, receipt.id]
    });
  });
  return receipt.id;
}

/**
 * Store-securely for provider-hosted legacy outputs: runs the existing
 * idempotent Cloudinary flow against the original provider URL (no
 * regeneration, no duplicate assets) and promotes the receipt on success.
 * On failure the receipt is marked storage-failed with an honest diagnostic
 * (expired provider links need regeneration, never a false success).
 */
export async function storeLegacyOutput(
  workspaceId: string,
  campaignId: string,
  jobId: string
): Promise<{ stored: boolean; message: string }> {
  const { persistJobAsset } = await import("../asset-store");
  const db = await loadDb();
  const campaign = db.campaigns.find((c) => c.id === campaignId);
  const job = campaign?.jobs.find((j) => j.id === jobId);
  const receipt = campaign?.receipts.find((r) => r.jobId === jobId);
  const providerUrl = job?.providerOutputUrl ?? job?.outputUrl;
  if (!campaign || !job || !receipt || !providerUrl) {
    return { stored: false, message: "Output not found — nothing was changed." };
  }
  if (receipt.storageStatus === "stored") return { stored: true, message: "Already stored in PermitFrame." };
  const outcome = await persistJobAsset({
    workspaceId,
    campaignId,
    job: {
      id: job.id,
      kind: job.kind,
      capability: job.capability,
      providerOutputUrl: providerUrl,
      livepeerJobId: job.livepeerJobId,
      costUsd: job.costUsd
    },
    promptHash: sha256(job.prompt),
    providerModel: job.capability
  });
  if (outcome.outcome === "stored") {
    const canonicalUrl = outcome.asset.secureUrl;
    await updateDb((d) => {
      const c = d.campaigns.find((x) => x.id === campaignId);
      const j = c?.jobs.find((x) => x.id === jobId);
      if (j) {
        j.outputUrl = canonicalUrl;
        if (!j.providerOutputUrl) j.providerOutputUrl = providerUrl;
      }
      const r = c?.receipts.find((x) => x.jobId === jobId);
      if (r) {
        r.outputUrl = canonicalUrl;
        r.storageProvider = "cloudinary";
        r.storagePublicId = outcome.asset.publicId;
        r.storageUrl = canonicalUrl;
        r.storageStatus = "stored";
      }
    });
    await getDb()
      .update(campaignAssets)
      .set({ receiptId: receipt.id, storageUrl: canonicalUrl, updatedAt: new Date() })
      .where(eq(campaignAssets.jobId, jobId))
      .catch(() => undefined);
    return { stored: true, message: "Stored in PermitFrame — share, download, and proof actions are unlocked." };
  }
  if (outcome.outcome === "deferred") {
    return { stored: false, message: "Durable storage is not configured — outputs stay provider-hosted." };
  }
  await updateDb((d) => {
    const r = d.campaigns.find((x) => x.id === campaignId)?.receipts.find((x) => x.jobId === jobId);
    if (r) r.storageStatus = "failed";
  });
  return {
    stored: false,
    message: `Secure storage failed (${outcome.error}) — the preview is intact. If the provider link expired, regenerate the stage for a fresh output.`
  };
}

/**
 * Complete delivery for a job whose durable asset is stored: flip the job
 * to succeeded with the canonical URL and publish its receipt. Used by the
 * storage-retry path (the hot path above inlines the same steps). Idempotent:
 * already-succeeded jobs and existing receipts are left untouched.
 */
export async function finalizeStoredJob(workspaceId: string, campaignId: string, jobId: string): Promise<{ finalized: boolean }> {
  const assets = await getCampaignAssets(workspaceId, campaignId).catch(() => []);
  const asset = assets.find((a) => a.jobId === jobId);
  if (!asset || asset.storageStatus !== "stored" || !asset.storageUrl) return { finalized: false };
  const db = await loadDb();
  const campaign = db.campaigns.find((c) => c.id === campaignId);
  const job = campaign?.jobs.find((j) => j.id === jobId);
  if (!campaign || !job || job.status === "ready_to_share") return { finalized: false };
  const canonicalUrl = asset.storageUrl;
  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === campaignId);
    const j = c?.jobs.find((x) => x.id === jobId);
    if (j) {
      j.status = "ready_to_share";
      j.outputUrl = canonicalUrl;
      j.finishedAt = nowIso();
    }
  });
  const receiptId = await publishReceipt(campaignId, jobId, canonicalUrl, job.capability, {
    publicId: asset.storagePublicId as string,
    url: canonicalUrl
  });
  if (receiptId) {
    await getDb()
      .update(campaignAssets)
      .set({ receiptId, updatedAt: new Date() })
      .where(eq(campaignAssets.jobId, jobId))
      .catch(() => undefined);
  }
  return { finalized: true };
}

export async function publishCampaignRecord(
  campaignId: string
): Promise<{ ual?: string; publicationStatus: PublicationStatus }> {
  const db = await loadDb();
  const campaign = db.campaigns.find((c) => c.id === campaignId);
  if (!campaign) return { publicationStatus: "failed" };
  try {
    // Campaign approval is the explicit moment we anchor minimized evidence
    // on-chain. Earlier facts/consents stay in WM/SWM unless separately chosen.
    const record = await getDkg().publishVerifiable(campaignKa(campaign), "shared");
    await updateDb((d) => {
      const c = d.campaigns.find((x) => x.id === campaignId);
      if (c) {
        c.campaignUAL = record.ual;
        c.publicationStatus = record.publicationStatus;
      }
    });
    return { ual: record.ual, publicationStatus: record.publicationStatus };
  } catch {
    await updateDb((d) => {
      const c = d.campaigns.find((x) => x.id === campaignId);
      if (c) c.publicationStatus = "failed";
    }).catch(() => undefined);
    return { publicationStatus: "failed" };
  }
}
