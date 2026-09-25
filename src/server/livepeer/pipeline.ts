import type { Campaign, Database, DerivativeReceipt, ProductionJob, PublicationStatus, QualityProfile, StageFidelity, StageInputSource, StageRole, Visibility } from "../types";
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
import { baseSepoliaTransactionUrl } from "@/lib/proof-links";

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
  fidelity?: StageFidelity;
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
    // Plan-time preservation request (role- and fidelity-derived,
    // refinement-agnostic): dispatch re-validates and records the resolved
    // outcome. Structured from the start so plan → job → receipt carries
    // one vocabulary.
    ...(stage.role
      ? {
          preservationRequested: requestedPreservationMode({ role: stage.role, variationExplicit: false, variationSourceUrl: undefined, fidelity: stage.fidelity })
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
  /** Test seam: deferred/failing ledger publish for atomicity tests. */
  publish?: ReceiptLedgerPublish;
}): Promise<void> {
  const scope = input.workspaceId;
  if (!isCloudinaryConfigured()) {
    // Provider-hosted delivery: durable storage unavailable, so the preview
    // itself delivers (labeled provider-hosted downstream). The
    // compare-and-set claim (preview_ready only) and the complete receipt
    // land in ONE workspace mutation via persistLocalDelivery - no observer
    // can read Ready without the receipt, and a duplicate worker finalizes
    // nothing. Anchoring is an explicit Review & deliver action, never an
    // automatic consequence of generation.
    const { receiptId, claimed } = await persistLocalDelivery({
      campaignId: input.campaignId,
      jobId: input.jobId,
      canonicalUrl: input.providerUrl,
      capability: input.providerModel,
      storage: null,
      scope,
      claimFrom: "preview_ready"
    });
    if (claimed && receiptId && input.publish) {
      await publishReceiptToLedger({ campaignId: input.campaignId, receiptId, scope, publish: input.publish }).catch(() => undefined);
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
    // Atomic local finalization: ready_to_share, canonical URL, completion
    // fields, and the complete receipt (ratio block included) land in ONE
    // write. Ledger anchoring is initiated only from Review & deliver.
    const { receiptId } = await persistLocalDelivery({
      campaignId: input.campaignId,
      jobId: input.jobId,
      canonicalUrl,
      capability: input.providerModel,
      storage: {
        publicId: outcome.asset.publicId,
        url: canonicalUrl,
        width: outcome.asset.width,
        height: outcome.asset.height
      },
      scope
    });
    if (receiptId && input.publish) {
      await publishReceiptToLedger({ campaignId: input.campaignId, receiptId, scope, publish: input.publish }).catch(() => undefined);
    }
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
  if (!submitted.workspaceId) return { finished: true, error: "Workspace unknown - cannot execute." };
  await pumpRun(submitted.workspaceId, campaignId, {
    runId: submitted.run.id,
    budgetMs: 10 * 60 * 1000
  }).catch(() => undefined);
  return { finished: true };
}


/**
 * Pure receipt construction (no I/O): the complete local receipt including
 * measured dimensions, aspectVerdict, and deliveryBlocked. DKG publication
 * is a separate later step - see publishReceiptToLedger.
 */
export function buildReceipt(
  campaign: Campaign,
  job: ProductionJob,
  outputUrl: string,
  capability: string,
  storage: { publicId: string; url: string; width?: number; height?: number } | null
): DerivativeReceipt {
  const measuredWidth = Number.isFinite(storage?.width) ? (storage?.width as number) : undefined;
  const measuredHeight = Number.isFinite(storage?.height) ? (storage?.height as number) : undefined;
  const stageFormat = campaign.preflight?.plan.find((s) => s.id === job.stageId)?.format ?? "9:16";
  // Hard delivery guard: a measured ratio mismatch is persisted as a
  // structured non-deliverable reason in the SAME receipt write, so the
  // output can never transiently read as shareable. Unknown (no measured
  // size, unplanned format) preserves legacy behavior - never a mismatch.
  const verdict = aspectVerdict(stageFormat, measuredWidth, measuredHeight);
  // Fidelity verdict for strict stages: the gate ran at finalization and
  // wrote requestMeta.fidelityCheck before this receipt was built. The
  // requirement travels only when strict; a failed check blocks delivery
  // exactly like a ratio mismatch (approval, share, and verification all
  // key off deliveryBlockReason).
  const stageFidelity = campaign.preflight?.plan.find((s) => s.id === job.stageId)?.fidelity;
  const fidelityCheck = job.requestMeta?.fidelityCheck;
  const receipt: DerivativeReceipt = {
    id: newId("rcpt"),
    campaignId: campaign.id,
    jobId: job.id,
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
    aspectVerdict: verdict,
    ...(verdict === "mismatch" ? { deliveryBlocked: "aspect_ratio_mismatch" as const } : {}),
    ...(stageFidelity === "product-preserving" || stageFidelity === "property-preserving"
      ? { sourceFidelity: stageFidelity }
      : {}),
    ...(fidelityCheck !== undefined ? { fidelityCheck } : {}),
    ...(fidelityCheck === "failed" ? { deliveryBlocked: "fidelity_check_failed" as const } : {}),
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
     ...(job.requestMeta?.providerFailureKind ? { providerFailureKind: job.requestMeta.providerFailureKind } : {}),
     ...(job.requestMeta?.providerFailureDetail ? { providerFailureDetail: job.requestMeta.providerFailureDetail } : {}),
     ...(job.requestMeta?.recoveryState ? { recoveryState: job.requestMeta.recoveryState } : {}),
     ...(job.requestMeta?.recoveryCapability ? { recoveryCapability: job.requestMeta.recoveryCapability } : {}),
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
  return receipt;
}

export interface LocalDeliveryInput {
  campaignId: string;
  jobId: string;
  canonicalUrl: string;
  capability: string;
  storage: { publicId: string; url: string; width?: number; height?: number } | null;
  scope?: string;
  /**
   * Compare-and-set claim: finalize only when the job currently holds this
   * status. Lets the provider-hosted branch claim preview_ready and persist
   * the receipt in the same mutation. Absent means no claim check (hot and
   * retry paths already hold their own claims).
   */
  claimFrom?: ProductionJob["status"];
}

/**
 * Atomic local finalization: ONE workspace mutation persists the complete
 * local receipt (dimensions, aspectVerdict, deliveryBlocked) together with
 * the job's canonical URL, completion fields, final ready_to_share status,
 * and the local event. No observer can ever see Ready without the receipt
 * (and its ratio block) already persisted. DKG publication happens only
 * after this write - see publishReceiptToLedger.
 *
 * Idempotent: an existing receipt is never duplicated and never mutated
 * (block reason and publication state preserved); a ready job with a
 * receipt is left fully untouched. A ready job missing its receipt (a
 * pre-atomicity window row) gets the receipt healed without touching the job.
 * With claimFrom, a status mismatch finalizes nothing (claimed: false) -
 * duplicate workers cannot re-finalize or duplicate the receipt.
 */
export async function persistLocalDelivery(input: LocalDeliveryInput): Promise<{ receiptId: string; created: boolean; claimed: boolean }> {
  let receiptId = "";
  let created = false;
  let claimed = input.claimFrom === undefined;
  const write = (mutator: (db: Database) => void): Promise<unknown> =>
    input.scope ? writeWorkspace(input.scope, mutator) : updateDb(mutator);
  await write((d) => {
    const c = d.campaigns.find((x) => x.id === input.campaignId);
    const j = c?.jobs.find((x) => x.id === input.jobId);
    if (!c || !j) return;
    if (input.claimFrom !== undefined && j.status !== input.claimFrom) {
      const raced = c.receipts.find((r) => r.jobId === input.jobId);
      if (raced) receiptId = raced.id;
      return;
    }
    claimed = true;
    const existing = c.receipts.find((r) => r.jobId === input.jobId);
    if (existing) {
      if (j.status !== "ready_to_share") {
        j.status = "ready_to_share";
        j.outputUrl = input.canonicalUrl;
        j.finishedAt = j.finishedAt ?? nowIso();
      }
      receiptId = existing.id;
      return;
    }
    const receipt = buildReceipt(c, j, input.canonicalUrl, input.capability, input.storage);
    j.status = "ready_to_share";
    j.outputUrl = input.canonicalUrl;
    j.finishedAt = j.finishedAt ?? nowIso();
    c.receipts.push(receipt);
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "production.receipt_recorded",
      summary: `Derivative receipt ${receipt.id} recorded for stage "${receipt.label}".`,
      refs: [input.campaignId, receipt.id]
    });
    receiptId = receipt.id;
    created = true;
  });
  return { receiptId, created, claimed };
}

/** Injectable ledger publisher (DKG). Tests swap in a deferred mock. */
export type ReceiptLedgerPublish = (
  knowledgeAsset: unknown,
  visibility: Visibility
) => Promise<{ ual: string; explorerUrl?: string; publicationStatus: PublicationStatus }>;

/**
 * Ledger publication for an already-persisted receipt. Reads the receipt
 * fresh, attempts DKG publish, and patches only the publication fields
 * (ual, ualExplorer, publicationStatus). A DKG timeout/failure records the
 * honest "failed" state - local delivery, ratio blocking, queue status,
 * and the share filter are already durable and unaffected. Never throws.
 * Receipts that stay unpublished (no UAL) are picked up by the republish
 * route, exactly as before.
 */
export async function publishReceiptToLedger(input: {
  campaignId: string;
  receiptId: string;
  scope?: string;
  publish?: ReceiptLedgerPublish;
}): Promise<void> {
  try {
    const db = input.scope ? await readWorkspace(input.scope) : await loadDb();
    const receipt = db.campaigns.find((c) => c.id === input.campaignId)?.receipts.find((r) => r.id === input.receiptId);
    if (!receipt || receipt.ual) return;
    const publish = input.publish ?? ((ka, visibility) => getDkg().publish(receiptKa(ka as DerivativeReceipt), visibility));
    const record = await publish(receiptKa(receipt), receipt.visibility);
    const write = (mutator: (db: Database) => void): Promise<unknown> =>
      input.scope ? writeWorkspace(input.scope, mutator) : updateDb(mutator);
    await write((d) => {
      const r = d.campaigns.find((x) => x.id === input.campaignId)?.receipts.find((x) => x.id === input.receiptId);
      if (!r || r.ual) return;
      r.ual = record.ual;
      r.ualExplorer = record.explorerUrl;
      r.publicationStatus = record.publicationStatus;
    }).catch(() => undefined);
  } catch {
    try {
      const write = (mutator: (db: Database) => void): Promise<unknown> =>
        input.scope ? writeWorkspace(input.scope, mutator) : updateDb(mutator);
      await write((d) => {
        const r = d.campaigns.find((x) => x.id === input.campaignId)?.receipts.find((x) => x.id === input.receiptId);
        // Preserve any concurrently published state; only record the failure
        // when the receipt still carries no ledger outcome.
        if (!r || r.ual || r.publicationStatus) return;
        r.publicationStatus = "failed";
      }).catch(() => undefined);
    } catch {
      // Local delivery is already durable; publication bookkeeping is best-effort.
    }
  }
}

/**
 * Full receipt flow preserving the original contract: atomic local
 * finalization first (job + receipt + block in one write). Anchoring is
 * deliberately opt-in through the optional publish hook; production uses
 * the explicit Review & deliver publication action instead.
 */
export async function publishReceipt(
  campaignId: string,
  jobId: string,
  outputUrl: string,
  capability: string,
  storage: { publicId: string; url: string; width?: number; height?: number } | null,
  scope?: string,
  opts?: { publish?: ReceiptLedgerPublish }
): Promise<string> {
  const { receiptId } = await persistLocalDelivery({
    campaignId,
    jobId,
    canonicalUrl: outputUrl,
    capability,
    storage,
    scope
  });
  if (!receiptId) return "";
  if (opts?.publish) {
    await publishReceiptToLedger({ campaignId, receiptId, scope, publish: opts.publish }).catch(() => undefined);
  }
  return receiptId;
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
 * to succeeded with the canonical URL and persist its receipt atomically
 * (same guarantees as the hot path), then publish to the ledger. Used by
 * the storage-retry path. Idempotent: already-delivered jobs and existing
 * receipts are left untouched; nothing is ever duplicated.
 */
export async function finalizeStoredJob(
  workspaceId: string,
  campaignId: string,
  jobId: string,
  opts?: { publish?: ReceiptLedgerPublish }
): Promise<{ finalized: boolean }> {
  const assets = await getCampaignAssets(workspaceId, campaignId).catch(() => []);
  const asset = assets.find((a) => a.jobId === jobId);
  return finalizeStoredDelivery({ workspaceId, campaignId, jobId, asset, publish: opts?.publish });
}

export interface StoredDeliveryAsset {
  storageStatus: string;
  storageUrl?: string | null;
  storagePublicId?: string | null;
  storageWidth?: number | null;
  storageHeight?: number | null;
}

/**
 * Retry-path core over an already-resolved durable asset. Workspace-seam
 * only (no Neon/Cloudinary reads), so atomicity tests drive this directly.
 * A stored asset with a non-ready job finalizes atomically; an
 * already-delivered job with a receipt is untouched; a ready job missing
 * its receipt is healed without duplicating anything.
 */
export async function finalizeStoredDelivery(input: {
  workspaceId: string;
  campaignId: string;
  jobId: string;
  asset: StoredDeliveryAsset | undefined;
  publish?: ReceiptLedgerPublish;
}): Promise<{ finalized: boolean }> {
  const { asset } = input;
  if (!asset || asset.storageStatus !== "stored" || !asset.storageUrl) return { finalized: false };
  const db = await readWorkspace(input.workspaceId);
  const campaign = db.campaigns.find((c) => c.id === input.campaignId);
  const job = campaign?.jobs.find((j) => j.id === input.jobId);
  if (!campaign || !job) return { finalized: false };
  if (job.status === "ready_to_share" && campaign.receipts.some((r) => r.jobId === input.jobId)) {
    return { finalized: false };
  }
  const canonicalUrl = asset.storageUrl;
  const { receiptId } = await persistLocalDelivery({
    campaignId: input.campaignId,
    jobId: input.jobId,
    canonicalUrl,
    capability: job.capability,
    storage: {
      publicId: asset.storagePublicId as string,
      url: canonicalUrl,
      width: asset.storageWidth ?? undefined,
      height: asset.storageHeight ?? undefined
    },
    scope: input.workspaceId
  });
  if (!receiptId) return { finalized: false };
  if (input.publish) {
    await publishReceiptToLedger({ campaignId: input.campaignId, receiptId, scope: input.workspaceId, publish: input.publish }).catch(() => undefined);
  }
  try {
    await getDb()
      .update(campaignAssets)
      .set({ receiptId, updatedAt: new Date() })
      .where(eq(campaignAssets.jobId, input.jobId))
      .catch(() => undefined);
  } catch {
    // Normalized mirror is best-effort; the workspace blob stays canonical.
  }
  return { finalized: true };
}

export async function publishCampaignRecord(
  campaignId: string
): Promise<{ ual?: string; txHash?: string; publicationStatus: PublicationStatus }> {
  const db = await loadDb();
  const campaign = db.campaigns.find((c) => c.id === campaignId);
  if (!campaign) return { publicationStatus: "failed" };
  try {
    // Campaign approval is the explicit moment we anchor minimized evidence
    // on-chain. Earlier facts/consents stay in WM/SWM unless separately chosen.
    const record = await getDkg().publishVerifiable(campaignKa(campaign), "shared");
    // A finalization hash is public only when it is tied to the genuine Base
    // Sepolia UAL returned by the finalized publish. Do not retain arbitrary
    // adapter output or hashes from local/shared records.
    const transaction = record.publicationStatus === "anchored"
      ? baseSepoliaTransactionUrl(record.ual, record.txHash)
      : null;
    await updateDb((d) => {
      const c = d.campaigns.find((x) => x.id === campaignId);
      if (c) {
        c.campaignUAL = record.ual;
        c.publicationStatus = record.publicationStatus;
        if (transaction && record.txHash) c.campaignTxHash = record.txHash.trim();
        else delete c.campaignTxHash;
      }
    });
    return {
      ual: record.ual,
      ...(transaction && record.txHash ? { txHash: record.txHash.trim() } : {}),
      publicationStatus: record.publicationStatus
    };
  } catch {
    await updateDb((d) => {
      const c = d.campaigns.find((x) => x.id === campaignId);
      if (c) {
        c.publicationStatus = "failed";
        delete c.campaignTxHash;
      }
    }).catch(() => undefined);
    return { publicationStatus: "failed" };
  }
}
