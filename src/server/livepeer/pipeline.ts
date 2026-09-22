import type { Campaign, Database, DerivativeReceipt, ProductionJob, PublicationStatus, QualityProfile, StageInputSource, StageRole } from "../types";
import { loadDb, newId, nowIso, sha256, updateDb } from "../store";
import { readWorkspace, writeWorkspace } from "./run-store";
import { getDb } from "../db/client";
import { campaignAssets } from "../db/schema";
import { eq } from "drizzle-orm";
import { getDkg } from "../dkg";
import { receiptKa, campaignKa } from "../dkg/schemas";
import { aspectVerdict } from "./aspect";
import { composeStagePrompt } from "../policy/engine";
import { requestedPreservationMode } from "./preservation-policy";
import { normalizeQualityProfile, normalizeStagePlan } from "./plan-dag";
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
  const profile = normalizeQualityProfile(campaign.request.qualityProfile ?? process.env.LIVEPEER_QUALITY_PROFILE);
  const plan = normalizeStagePlan(campaign.preflight?.plan ?? [], profile);
  const wanted = stageIds && stageIds.length > 0 ? new Set(stageIds) : null;
  return plan
    .filter((stage) => !wanted || wanted.has(stage.id))
    .map((stage) => ({
      id: newId("job"),
      campaignId: campaign.id,
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
    }));
}

/** Storage-safe description of what a stage asks the provider for. */
export function requestMetaFor(stage: {
  kind: string;
  format: string;
  durationSeconds?: number;
  requestedDurationSeconds?: number;
  durationNote?: string;
  durationSource?: "provider-metadata" | "documented-model-policy" | "product-range-unverified";
  inputSource?: StageInputSource;
  qualityProfile?: QualityProfile;
  role?: StageRole;
  fallbackFrom?: string;
}): NonNullable<ProductionJob["requestMeta"]> {
  return {
    aspectRatio: stage.format,
    ...((stage.kind === "image-to-video" || stage.durationSeconds !== undefined)
      ? { durationSeconds: stage.durationSeconds ?? 5 }
      : {}),
    ...(stage.kind === "image-to-video" && stage.requestedDurationSeconds !== undefined
      ? { requestedDurationSeconds: stage.requestedDurationSeconds }
      : {}),
    ...(stage.durationNote ? { durationNote: stage.durationNote } : {}),
    ...(stage.durationSource ? { durationSource: stage.durationSource } : {}),
    ...(stage.inputSource ? { inputSource: stage.inputSource } : {}),
    ...(stage.qualityProfile ? { qualityProfile: stage.qualityProfile } : {}),
    ...(stage.role ? { role: stage.role } : {}),
    ...(stage.fallbackFrom ? { fallbackFrom: stage.fallbackFrom } : {}),
    // Plan-time preservation request (role-derived, refinement-agnostic):
    // dispatch re-validates and records the resolved outcome. Structured
    // from the start so plan → job → receipt carries one vocabulary.
    ...(stage.role
      ? {
          preservationRequested: requestedPreservationMode({ role: stage.role, variationExplicit: false, variationSourceUrl: undefined })
        }
      : {})
  };
}

/** Mark a stage's queued jobs failed with an honest cause (DAG propagation).
 * Pass onlyJobIds to fail just those jobs (exact-job runs): siblings
 * sharing the stageId are never failed merely for sharing it. */
export async function failStageJobs(campaignId: string, stageId: string, message: string, scope?: string, onlyJobIds?: string[]): Promise<void> {
  const write = (mutator: (db: Database) => void): Promise<unknown> =>
    scope ? writeWorkspace(scope, mutator) : updateDb(mutator);
  const owned = onlyJobIds && onlyJobIds.length > 0 ? new Set(onlyJobIds) : null;
  await write((d) => {
    const c = d.campaigns.find((x) => x.id === campaignId);
    if (c) {
      let touched = false;
      for (const j of c.jobs) {
        if (j.stageId === stageId && (j.status === "queued" || j.status === "generating")) {
          if (owned && !owned.has(j.id)) continue;
          j.status = "failed";
          j.error = message.slice(0, 400);
          j.finishedAt = nowIso();
          touched = true;
        }
      }
      if (touched) c.status = "review";
    }
  });
}

/** Storage worker for one previewed job. Compare-and-set on preview_ready
 * makes double polls harmless: only the first worker proceeds. */
export async function persistPreviewInBackground(input: {
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
  const scope = input.workspaceId;
  if (!isCloudinaryConfigured()) {
    // Legacy delivery: durable storage unavailable, so the preview itself
    // delivers (labeled provider-hosted downstream).
    const delivered = await transitionJob(input.campaignId, input.jobId, "preview_ready", "ready_to_share", scope);
    if (delivered) {
      await writeWorkspace(scope, (d) => {
        const j = d.campaigns.find((x) => x.id === input.campaignId)?.jobs.find((x) => x.id === input.jobId);
        if (j) j.finishedAt = nowIso();
      });
      await publishReceipt(input.campaignId, input.jobId, input.providerUrl, input.providerModel, null, scope);
    }
    return;
  }
  const claimed = await transitionJob(input.campaignId, input.jobId, "preview_ready", "storage_pending", scope);
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
    await writeWorkspace(scope, (d) => {
      const j = d.campaigns.find((x) => x.id === input.campaignId)?.jobs.find((x) => x.id === input.jobId);
      if (j) {
        j.status = "ready_to_share";
        j.outputUrl = canonicalUrl;
        j.finishedAt = nowIso();
      }
    });
    const receiptId = await publishReceipt(input.campaignId, input.jobId, canonicalUrl, input.providerModel, {
      publicId: outcome.asset.publicId,
      url: canonicalUrl,
      width: outcome.asset.width,
      height: outcome.asset.height
    }, scope);
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
    await transitionJob(input.campaignId, input.jobId, "storage_pending", "preview_ready", scope);
    return;
  }
  // Failed: preview intact, retryable within the attempt budget.
  await transitionJob(input.campaignId, input.jobId, "storage_pending", "storage_retry_needed", scope);
}

/** Compare-and-set a job status. Returns true only when it transitioned. */
export async function transitionJob(campaignId: string, jobId: string, from: ProductionJob["status"], to: ProductionJob["status"], scope?: string): Promise<boolean> {
  let moved = false;
  const write = (mutator: (db: Database) => void): Promise<unknown> =>
    scope ? writeWorkspace(scope, mutator) : updateDb(mutator);
  await write((d) => {
    const j = d.campaigns.find((x) => x.id === campaignId)?.jobs.find((x) => x.id === jobId);
    if (j && j.status === from) {
      j.status = to;
      moved = true;
    }
  });
  return moved;
}

export async function runProduction(campaignId: string, onlyStageIds?: string[], workspaceId?: string): Promise<{ finished: boolean; error?: string }> {
  // Compatibility entry point: the sequential chain is gone — execution is
  // the dependency-aware async pump (bounded concurrency, resume from
  // durable records). Awaits pump completion with a generous budget, same
  // contract as before for detached callers.
  const { submitRun, pumpRun } = await import("./runner");
  const submitted = await submitRun({ campaignId, stageIds: onlyStageIds, workspaceId });
  if (!submitted.run) return { finished: true, error: submitted.error };
  if (!submitted.workspaceId) return { finished: true, error: "Workspace unknown — cannot execute." };
  await pumpRun(submitted.workspaceId, campaignId, {
    runId: submitted.run.id,
    budgetMs: 10 * 60 * 1000
  }).catch(() => undefined);
  return { finished: true };
}


export async function publishReceipt(
  campaignId: string,
  jobId: string,
  outputUrl: string,
  capability: string,
  storage: { publicId: string; url: string; width?: number; height?: number } | null,
  scope?: string
): Promise<string> {
  const db = scope ? await readWorkspace(scope) : await loadDb();
  const campaign = db.campaigns.find((c) => c.id === campaignId);
  const job = campaign?.jobs.find((j) => j.id === jobId);
  if (!campaign || !job) return "";

  const measuredWidth = Number.isFinite(storage?.width) ? (storage?.width as number) : undefined;
  const measuredHeight = Number.isFinite(storage?.height) ? (storage?.height as number) : undefined;
  const stageFormat = campaign.preflight?.plan.find((s) => s.id === job.stageId)?.format ?? "9:16";
  const receipt: DerivativeReceipt = {
    id: newId("rcpt"),
    campaignId,
    jobId,
    label: campaign.preflight?.plan.find((s) => s.id === job.stageId)?.label ?? job.stageId,
    mediaType: job.kind === "image-to-video" ? "video" : "image",
    format: stageFormat,
    outputUrl,
    // Measured size from durable storage metadata (absent for legacy and
    // provider-hosted rows) — the only honest source for "is it really 1:1".
    ...(measuredWidth !== undefined && measuredHeight !== undefined
      ? { actualWidth: measuredWidth, actualHeight: measuredHeight }
      : {}),
    // Requested-vs-delivered verdict persisted with the receipt: mismatches
    // are never Ready for the requested placement (approval gates on this).
    aspectVerdict: aspectVerdict(stageFormat, measuredWidth, measuredHeight),
    // URL fingerprint for correlation only — never content evidence (see types).
    providerUrlFingerprint: job.providerUrlFingerprint ?? sha256(outputUrl),
    capability,
    promptHash: sha256(job.prompt),
    claimsUsed: campaign.preflight?.allowedClaims ?? [],
    // Exact model provenance: what was requested (profile + first pick)
    // versus what actually rendered (clean actual capability - never text).
    qualityProfile: job.qualityProfile,
    role: job.role,
    requestedCapability: job.requestedCapability ?? job.capability,
    actualCapability: job.actualCapability ?? capability,
    // Motion clip provenance: resolved length dispatched + requested length.
    ...(job.kind === "image-to-video"
      ? {
          ...(job.requestMeta?.durationSeconds !== undefined ? { durationSeconds: job.requestMeta.durationSeconds } : {}),
          ...(job.requestMeta?.requestedDurationSeconds !== undefined
            ? { requestedDurationSeconds: job.requestMeta.requestedDurationSeconds }
            : {}),
          ...(job.requestMeta?.durationSource ? { durationSource: job.requestMeta.durationSource } : {}),
          ...(job.requestMeta?.durationNote ? { durationNote: job.requestMeta.durationNote } : {})
        }
      : {}),
    derivedFrom: {
      sourceMediaId: campaign.sourceMediaId,
      passportId: campaign.passportId,
      productFactsId: campaign.productFactsId,
      ...(job.requestMeta?.sourceStageId ? { sourceStageId: job.requestMeta.sourceStageId } : {})
    },
    // Preservation provenance copied from the rendering job: what actually
    // ran (resolved tool, claimable evidence, fallback reason), never what
    // was merely planned. Legacy jobs without these fields stay readable -
    // the UI normalizes them to "no claim".
    ...(job.requestMeta?.preservationRequested ? { preservationRequested: job.requestMeta.preservationRequested } : {}),
    ...(job.requestMeta?.preservationResolved ? { preservationResolved: job.requestMeta.preservationResolved } : {}),
    ...(job.requestMeta?.preservationEvidenceLevel ? { preservationEvidenceLevel: job.requestMeta.preservationEvidenceLevel } : {}),
    ...(job.requestMeta?.preservationRequestedCapability ? { preservationRequestedCapability: job.requestMeta.preservationRequestedCapability } : {}),
    ...(job.requestMeta?.preservationActualCapability ? { preservationActualCapability: job.requestMeta.preservationActualCapability } : {}),
    ...(job.requestMeta?.approvedSourceAssetId ? { approvedSourceAssetId: job.requestMeta.approvedSourceAssetId } : {}),
    ...(job.requestMeta?.fallbackReason ? { fallbackReason: job.requestMeta.fallbackReason } : {}),
    ...(job.requestMeta?.providerOperationSucceeded !== undefined
      ? { providerOperationSucceeded: job.requestMeta.providerOperationSucceeded }
      : {}),
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

  const pushReceipt = (d: Database): void => {
    const c = d.campaigns.find((x) => x.id === campaignId);
    if (c) c.receipts.push(receipt);
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "dkg.publish",
      summary: `Derivative receipt ${receipt.id} published for stage "${receipt.label}".`,
      refs: [campaignId, receipt.id]
    });
  };
  if (scope) await writeWorkspace(scope, pushReceipt);
  else await updateDb(pushReceipt);
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
    return { stored: false, message: "Output not found - nothing was changed." };
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
    return { stored: true, message: "Stored in PermitFrame - share, download, and proof actions are unlocked." };
  }
  if (outcome.outcome === "deferred") {
    return { stored: false, message: "Durable storage is not configured - outputs stay provider-hosted." };
  }
  await updateDb((d) => {
    const r = d.campaigns.find((x) => x.id === campaignId)?.receipts.find((x) => x.jobId === jobId);
    if (r) r.storageStatus = "failed";
  });
  return {
    stored: false,
    message: `Secure storage failed (${outcome.error}) - the preview is intact. If the provider link expired, regenerate the stage for a fresh output.`
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
    url: canonicalUrl,
    width: asset.storageWidth ?? undefined,
    height: asset.storageHeight ?? undefined
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
