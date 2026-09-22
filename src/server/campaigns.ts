import type { Campaign, CampaignRequest, Platform, ProductionJob, PublicationStatus } from "./types";
import { hasSharableReceipt } from "./types";
import { loadDb, newId, nowIso, updateDb } from "./store";
import { eq } from "drizzle-orm";
import { getDb } from "./db/client";
import { workspaces } from "./db/schema";
import { requireCurrentSession } from "./auth";
import { preflight, composeStagePrompt } from "./policy/engine";
import { effectiveCampaignStatus, preflightEvent } from "./campaign-status";
import { buildPublicSnapshot, newVerificationRef, saveVerificationSnapshot } from "./verify";
import {
  applyArchiveToDb,
  applyDeleteToDb,
  CampaignDeletedError,
  CampaignNotFoundError,
  CampaignProtectedError,
  deletedTitle,
  deletionEligibility,
  forceDeleteEligibility,
  isDeleted,
  WorkspaceOwnerRequiredError
} from "./deletion";
import {
  completeIdempotencySlot,
  failIdempotencySlot,
  fingerprintCreationIntent,
  IdempotencyMismatchError,
  reserveIdempotencySlot,
  withIdempotencyLock
} from "./idempotency";
import { publishCampaignRecord, requestMetaFor } from "./livepeer/pipeline";
import { getTemplate, validateTemplateSelection, type TemplateSelection } from "./livepeer/templates";
import { checkProfileAccess, resolveEntitlements } from "./entitlements";

export async function loadCampaign(id: string): Promise<Campaign | undefined> {
  return (await loadDb()).campaigns.find((c) => c.id === id);
}

/**
 * Only the workspace owner may delete or archive campaigns. Sessions are
 * already workspace-scoped; this additionally verifies ownership against the
 * workspaces table so a non-owner session (shared/future multi-user flows)
 * can never destroy data.
 */
export async function requireWorkspaceOwner(): Promise<{ userId: string; workspaceId: string }> {
  const session = await requireCurrentSession();
  const [workspace] = await getDb()
    .select({ ownerId: workspaces.ownerId })
    .from(workspaces)
    .where(eq(workspaces.id, session.workspaceId))
    .limit(1);
  if (!workspace || workspace.ownerId !== session.userId) throw new WorkspaceOwnerRequiredError();
  return { userId: session.userId, workspaceId: session.workspaceId };
}

/** Archived campaigns are read-only history: no edits, production, approval or variants. */
export function throwIfArchived(campaign: Campaign, action: string): void {
  if (campaign.status === "archived") {
    throw new Error(`Archived campaigns are read-only - “${campaign.title}” cannot be ${action}. It is kept for audit history.`);
  }
}

export interface CreateCampaignInput {
  title: string;
  brand: string;
  productName: string;
  creatorId: string;
  sourceMediaId: string;
  passportId: string;
  productFactsId: string;
  request: CampaignRequest;
  contextNote?: string;
}

export async function createCampaign(input: CreateCampaignInput): Promise<Campaign> {
  const campaign: Campaign = {
    id: newId("cmp"),
    title: input.title,
    brand: input.brand,
    productName: input.productName,
    request: input.request,
    status: "draft",
    jobs: [],
    receipts: [],
    runs: [],
    comments: [],
    captions: [],
    creatorId: input.creatorId,
    sourceMediaId: input.sourceMediaId,
    passportId: input.passportId,
    productFactsId: input.productFactsId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    contextNote: input.contextNote
  };
  campaign.preflight = await preflight(campaign);
  if (campaign.preflight.decision === "block") campaign.status = "blocked";
  const createdEvent = preflightEvent(campaign, campaign.preflight);
  await updateDb((d) => {
    d.campaigns.push(campaign);
    d.events.push(createdEvent);
  });
  return campaign;
}

/**
 * Idempotent creation: the same workspace + idempotency key always resolves
 * to one campaign. The key is client-generated per submission attempt and the
 * slot lives in the workspace state (durable across retries, restarts and
 * client aborts); an in-process lock additionally serializes concurrent
 * same-key requests into a single creation whose result is shared.
 *
 * - 201 created: first completion under this key.
 * - 200 replayed (`deduplicated: true`): retry of an already-completed key -
 *   returns the ORIGINAL campaign id, never a new row.
 * - "processing"/"failed" rows with no live holder (crashed or timed-out
 *   attempt) are taken over and run once more; failed attempts never replay.
 * - Same key + different payload → IdempotencyMismatchError (422).
 */
export async function createCampaignIdempotent(
  input: CreateCampaignInput,
  key: string,
  lockKey: string
): Promise<{ campaign: Campaign; deduplicated: boolean }> {
  const fingerprint = fingerprintCreationIntent({
    title: input.title,
    brand: input.brand,
    productName: input.productName,
    creatorId: input.creatorId,
    sourceMediaId: input.sourceMediaId,
    passportId: input.passportId,
    productFactsId: input.productFactsId,
    platform: input.request.platform,
    country: input.request.country,
    requestedClaims: input.request.requestedClaims,
    transformation: input.request.transformation,
    creativeBrief: input.request.creativeBrief,
    qualityProfile: input.request.qualityProfile
  });
  return withIdempotencyLock(lockKey, async () => {
    const now = nowIso();
    let reserved: ReturnType<typeof reserveIdempotencySlot> | undefined;
    await updateDb((d) => {
      reserved = reserveIdempotencySlot(d, key, fingerprint, now);
    });
    if (!reserved || reserved.outcome === "reserved" || reserved.outcome === "takeover") {
      try {
        const campaign = await createCampaign(input);
        await updateDb((d) => completeIdempotencySlot(d, key, campaign.id, nowIso()));
        return { campaign, deduplicated: false };
      } catch (error) {
        // Never leave a poisoned "processing" row: the next retry may take over.
        await updateDb((d) => failIdempotencySlot(d, key, nowIso())).catch(() => undefined);
        throw error;
      }
    }
    if (reserved.outcome === "mismatch") throw new IdempotencyMismatchError();
    const original = await loadCampaign(reserved.campaignId);
    if (original) return { campaign: original, deduplicated: true };
    // Defensive only (campaigns have no delete path): the slot claims a
    // campaign that no longer exists, so create once under the same key
    // rather than bricking the submission - UNLESS it was hard-deleted, in
    // which case resurrecting it would violate the deletion. Answer 410.
    const db = await loadDb();
    if (isDeleted(db, reserved.campaignId)) {
      throw new CampaignDeletedError(deletedTitle(db, reserved.campaignId) ?? reserved.campaignId);
    }
    const healed = await createCampaign(input);
    await updateDb((d) => completeIdempotencySlot(d, key, healed.id, nowIso()));
    return { campaign: healed, deduplicated: false };
  });
}

/** Re-check an existing campaign against the current graph (rights may have changed). */
export async function rePreflight(id: string): Promise<Campaign | undefined> {
  const campaign = await loadCampaign(id);
  if (!campaign) return undefined;
  throwIfArchived(campaign, "re-checked");
  campaign.preflight = await preflight(campaign);
  campaign.status = campaign.preflight.decision === "block" ? "blocked" : campaign.status === "blocked" ? "draft" : campaign.status;
  const event = preflightEvent(campaign, campaign.preflight);
  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === id);
    if (c) {
      c.preflight = campaign.preflight;
      c.status = campaign.status;
      c.updatedAt = nowIso();
    }
    d.events.push(event);
  });
  return loadCampaign(id);
}

/**
 * Apply a template-driven production spec, then rebuild the plan through
 * the normal preflight path (rights are re-checked; a re-block keeps
 * generation locked). Only allow-verdict campaigns may apply a template -
 * blocked campaigns never reach generation. Queued jobs for retired stages
 * are dropped (they never ran - nothing was spent); delivered, failed, and
 * preview history is kept.
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

export interface BriefPatch {
  title?: string;
  creativeBrief?: string;
  objective?: string;
  primaryMessage?: string;
  visualDirection?: string;
  requestedClaims?: string[];
  platform?: Platform;
  country?: string;
  transformation?: "image" | "video";
  sourceMediaId?: string;
}

const PLATFORMS: Platform[] = ["instagram", "tiktok", "youtube", "linkedin"];

/**
 * Studio brief edit: editorial fields (title, brief text, objective, message,
 * direction) save directly; rights inputs (platform, country, claims,
 * transformation) re-run preflight and can re-block the campaign, which
 * locks generation via the existing allow-gate. Structural inputs
 * (platform, country, transformation, source media) are locked once
 * production has started - use a platform variant instead.
 */
export async function updateCampaignBrief(
  id: string,
  patch: BriefPatch
): Promise<{ campaign?: Campaign; error?: string }> {
  const campaign = await loadCampaign(id);
  if (!campaign) return { error: "Campaign not found" };
  try {
    throwIfArchived(campaign, "edited");
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Archived campaigns are read-only." };
  }

  const structural =
    patch.platform !== undefined ||
    patch.country !== undefined ||
    patch.transformation !== undefined ||
    patch.sourceMediaId !== undefined;
  if (structural && campaign.jobs.length > 0) {
    return { error: "Platform, country, format and source are locked once production has started - clone a platform variant instead." };
  }

  if (patch.platform !== undefined && !PLATFORMS.includes(patch.platform)) {
    return { error: "Unknown platform." };
  }
  if (patch.country !== undefined && patch.country.trim().length !== 2) {
    return { error: "Use a 2-letter country code (e.g. GR for Greece, DE for Germany)." };
  }
  if (patch.transformation !== undefined && patch.transformation !== "image" && patch.transformation !== "video") {
    return { error: "Unknown format." };
  }
  if (patch.creativeBrief !== undefined && patch.creativeBrief.trim().length < 12) {
    return { error: "Give the brief a little more to work with (12+ characters)." };
  }
  if (patch.sourceMediaId !== undefined) {
    const media = (await loadDb()).sourceMedia.find((m) => m.id === patch.sourceMediaId);
    if (!media) return { error: "Selected source media was not found." };
  }

  const policyTouched =
    patch.platform !== undefined ||
    patch.country !== undefined ||
    patch.requestedClaims !== undefined ||
    patch.transformation !== undefined;

  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === id);
    if (!c) return;
    if (patch.title !== undefined) c.title = patch.title.trim() || c.title;
    if (patch.creativeBrief !== undefined) c.request.creativeBrief = patch.creativeBrief.trim();
    if (patch.objective !== undefined) c.request.objective = patch.objective.trim() || undefined;
    if (patch.primaryMessage !== undefined) c.request.primaryMessage = patch.primaryMessage.trim() || undefined;
    if (patch.visualDirection !== undefined) c.request.visualDirection = patch.visualDirection.trim() || undefined;
    if (patch.requestedClaims !== undefined) c.request.requestedClaims = patch.requestedClaims;
    if (patch.platform !== undefined) c.request.platform = patch.platform;
    if (patch.country !== undefined) c.request.country = patch.country.trim().toUpperCase();
    if (patch.transformation !== undefined) c.request.transformation = patch.transformation;
    if (patch.sourceMediaId !== undefined) c.sourceMediaId = patch.sourceMediaId;
    c.updatedAt = nowIso();
  });

  if (policyTouched) {
    const updated = await loadCampaign(id);
    if (!updated) return { error: "Campaign not found" };
    updated.preflight = await preflight(updated);
    updated.status =
      updated.preflight.decision === "block" ? "blocked" : updated.status === "blocked" ? "draft" : updated.status;
    const event = preflightEvent(updated, updated.preflight);
    await updateDb((d) => {
      const c = d.campaigns.find((x) => x.id === id);
      if (c) {
        c.preflight = updated.preflight;
        c.status = updated.status;
        c.updatedAt = nowIso();
      }
      d.events.push(event);
    });
  }
  const final = await loadCampaign(id);
  if (!final) return { error: "Campaign not found" };
  return { campaign: final };
}

/** Kick off production: durable records are created synchronously and the request returns fast with a run id; the dependency-aware pump executes in the background (bounded concurrency) and any later request resumes it. */
export async function startProduction(
  id: string,
  capabilityOverride?: string,
  stageIds?: string[],
  idempotencyKey?: string
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
    workspaceId
  });
  if (!submitted.run) return { started: false, error: submitted.error ?? "Run submission failed" };
  void pumpRun(workspaceId, id, { runId: submitted.run.id, budgetMs: 8 * 60 * 1000 }).catch(() => undefined);
  return { started: true, runId: submitted.run.id };
}


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

export async function approveCampaign(id: string): Promise<{ approved: boolean; ual?: string; publicationStatus?: PublicationStatus; verificationRef?: string; verificationWarning?: string; error?: string }> {
  const campaign = await loadCampaign(id);
  if (!campaign) return { approved: false, error: "Campaign not found" };
  try {
    throwIfArchived(campaign, "approved");
  } catch (e) {
    return { approved: false, error: e instanceof Error ? e.message : "Archived campaigns are read-only." };
  }
  // Gate on the effective verdict, not the stored label: a stale "draft" row
  // whose preflight denies must never be approvable.
  if (effectiveCampaignStatus(campaign) === "blocked") return { approved: false, error: "Blocked campaigns cannot be approved" };
  if (campaign.jobs.filter((j) => j.status === "ready_to_share").length === 0) {
    return { approved: false, error: "Produce the campaign pack before approving - previews and unsaved outputs cannot be signed off yet" };
  }
  // Proof needs durable identity: provider-hosted legacy outputs must be
  // stored securely first — approval publishes evidence, never previews.
  if (!campaign.receipts.some((r) => hasSharableReceipt(r))) {
    return { approved: false, error: "Store outputs securely before approving — provider-hosted legacy assets cannot be published as proof yet" };
  }
  // Aspect honesty: a stored output whose measured file differs from the
  // requested placement is never Ready for that placement. Name the stages
  // and point at the explicit regenerate action — nothing auto-retries.
  const mismatched = campaign.receipts.filter((r) => hasSharableReceipt(r) && r.aspectVerdict === "mismatch");
  if (mismatched.length > 0) {
    const names = mismatched
      .map((r) => {
        const actual =
          r.actualWidth !== undefined && r.actualHeight !== undefined
            ? `${r.actualWidth}×${r.actualHeight}`
            : "unknown size";
        return `“${r.label}” (requested ${r.format}, received ${actual})`;
      })
      .join("; ")
      .slice(0, 220);
    return {
      approved: false,
      error: `Aspect check failed — ${names}. Regenerate the listed stage${mismatched.length === 1 ? "" : "s"} for the planned placement, then approve.`
    };
  }
  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === id);
    if (c) {
      c.status = "approved";
      c.updatedAt = nowIso();
    }
  });
  // On-chain anchoring (SWM publish + async publisher poll + verification
  // snapshot) runs detached: the publisher poll alone can take minutes and
  // no HTTP request should await it (proxies/browsers drop long-idle
  // connections). The UI polls the campaign until the UAL lands; the
  // existing "pending" banner covers the interim. Same fire-and-forget
  // shape as production jobs above.
  await updateDb((d) => {
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "campaign.approved",
      summary: `Campaign pack approved for "${campaign.title}".`,
      refs: [id]
    });
  });
  void (async () => {
    await publishCampaignRecord(id);
    try {
      const fresh = await loadCampaign(id);
      if (fresh) {
        const db = await loadDb();
        const ref = fresh.verificationRef ?? newVerificationRef();
        await saveVerificationSnapshot(
          buildPublicSnapshot({
            ref,
            campaign: fresh,
            passport: db.passports.find((p) => p.id === fresh.passportId) ?? null,
            facts: db.productFacts.find((f) => f.id === fresh.productFactsId) ?? null
          })
        );
        await updateDb((d) => {
          const c = d.campaigns.find((x) => x.id === id);
          if (c) {
            c.verificationRef = ref;
            c.updatedAt = nowIso();
          }
        });
      }
    } catch {
      // Snapshot failures never undo the approval: the "no public
      // verification link yet" panel plus Refresh button covers recovery.
    }
  })().catch(() => undefined);
  return { approved: true };
}

/**
 * Hard-delete a campaign. Owner-only. Allowed solely for workspace-local
 * drafts (see deletionEligibility): the row, jobs, receipts and plan are
 * removed, a tombstone is recorded (idempotent retries succeed), activity
 * events stay, and DKG state is never touched - deletable campaigns have no
 * public proof by construction.
 *
 * Archived records are refused UNLESS `force: true` is passed explicitly -
 * the hidden last-resort path. Even force never deletes while jobs run, and
 * force on a non-archived campaign is rejected (use the normal flows).
 */
export async function deleteCampaign(
  id: string,
  opts?: { force?: boolean }
): Promise<{ deleted: true; alreadyDeleted: boolean; title: string }> {
  await requireWorkspaceOwner();
  const tombstoned = isDeleted(await loadDb(), id);
  if (tombstoned) {
    const title = deletedTitle(await loadDb(), id) ?? id;
    return { deleted: true, alreadyDeleted: true, title };
  }
  const campaign = await loadCampaign(id);
  if (!campaign) throw new CampaignNotFoundError(id);
  if (campaign.status === "archived") {
    if (!opts?.force) {
      const eligibility = deletionEligibility(campaign);
      throw new CampaignProtectedError(eligibility.reasons, eligibility.archiveAvailable);
    }
    const force = forceDeleteEligibility(campaign);
    if (!force.allowed) {
      throw new CampaignProtectedError(force.reasons, false);
    }
  } else {
    if (opts?.force) {
      throw new CampaignProtectedError(["Force delete applies only to archived records - use the normal delete or archive flow."], true);
    }
    const eligibility = deletionEligibility(campaign);
    if (!eligibility.deletable) {
      throw new CampaignProtectedError(eligibility.reasons, eligibility.archiveAvailable);
    }
  }
  const now = nowIso();
  const eventId = newId("evt");
  let result: { deleted: true; alreadyDeleted: boolean; title: string } | undefined;
  await updateDb((d) => {
    result = applyDeleteToDb(d, id, now, eventId);
  });
  // applyDeleteToDb throws for unknown ids, so result is always set here.
  return result ?? { deleted: true, alreadyDeleted: true, title: campaign.title };
}

/**
 * Owner-only "Refresh verification link" for pre-snapshot approvals: builds a
 * NEW opaque snapshot from the campaign's REAL current data (honest
 * publication status included) and attaches its reference. Never marks
 * anything verified, never rewrites status or proof - a record whose publish
 * never anchored still reads "Campaign record saved", not public.
 */
export async function refreshVerificationSnapshot(id: string): Promise<{ verificationRef: string; created: boolean }> {
  await requireWorkspaceOwner();
  const campaign = await loadCampaign(id);
  if (!campaign) throw new CampaignNotFoundError(id);
  if (campaign.status !== "approved") {
    throw new CampaignProtectedError(["Only approved campaign packs can receive a verification link."], false);
  }
  const db = await loadDb();
  const ref = campaign.verificationRef ?? newVerificationRef();
  const created = !campaign.verificationRef;
  await saveVerificationSnapshot(
    buildPublicSnapshot({
      ref,
      campaign,
      passport: db.passports.find((p) => p.id === campaign.passportId) ?? null,
      facts: db.productFacts.find((f) => f.id === campaign.productFactsId) ?? null
    })
  );
  const now = nowIso();
  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === id);
    if (c) {
      c.verificationRef = ref;
      c.updatedAt = now;
    }
    d.events.push({
      id: newId("evt"),
      at: now,
      kind: "campaign.verification-refreshed",
      summary: `Verification link ${created ? "created" : "refreshed"} for "${campaign.title}" from its real approval data.`,
      refs: [id]
    });
  });
  return { verificationRef: ref, created };
}

/**
 * Archive a campaign in place. Owner-only. Available for any campaign
 * without running jobs (including protected ones): the row stays readable
 * but leaves Campaigns/Overview/metrics. Idempotent.
 */
export async function archiveCampaign(id: string): Promise<{ archived: true; alreadyArchived: boolean; title: string }> {
  await requireWorkspaceOwner();
  const campaign = await loadCampaign(id);
  // Deleted rows stay deleted: archiving a tombstone is a 404, never a resurrection.
  if (!campaign) throw new CampaignNotFoundError(id);
  const eligibility = deletionEligibility(campaign);
  if (eligibility.busy) {
    throw new CampaignProtectedError(eligibility.reasons, false);
  }
  const now = nowIso();
  const eventId = newId("evt");
  let result: { archived: true; alreadyArchived: boolean; title: string } | undefined;
  await updateDb((d) => {
    result = applyArchiveToDb(d, id, now, eventId);
  });
  return result ?? { archived: true, alreadyArchived: true, title: campaign.title };
}
