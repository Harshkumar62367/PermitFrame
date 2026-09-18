import type { Campaign, CampaignRequest, Platform, ProductionJob, PublicationStatus } from "./types";
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
import { createJobRecords, publishCampaignRecord, requestMetaFor, runProduction } from "./livepeer/pipeline";

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
    throw new Error(`Archived campaigns are read-only — “${campaign.title}” cannot be ${action}. It is kept for audit history.`);
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
 * - 200 replayed (`deduplicated: true`): retry of an already-completed key —
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
    creativeBrief: input.request.creativeBrief
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
    // rather than bricking the submission — UNLESS it was hard-deleted, in
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
 * production has started — use a platform variant instead.
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
    return { error: "Platform, country, format and source are locked once production has started — clone a platform variant instead." };
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

/** Kick off production: job records are created synchronously, execution runs in background. */
export async function startProduction(
  id: string,
  capabilityOverride?: string,
  stageIds?: string[]
): Promise<{ started: boolean; error?: string }> {
  const campaign = await loadCampaign(id);
  if (!campaign) return { started: false, error: "Campaign not found" };
  try {
    throwIfArchived(campaign, "produced");
  } catch (e) {
    return { started: false, error: e instanceof Error ? e.message : "Archived campaigns are read-only." };
  }
  if (campaign.preflight?.decision !== "allow") return { started: false, error: "Preflight has not approved this campaign" };

  const planIds = (campaign.preflight?.plan ?? []).map((s) => s.id);
  const wanted = stageIds && stageIds.length > 0 ? stageIds.filter((s) => planIds.includes(s)) : planIds;
  if (wanted.length === 0) return { started: false, error: "No matching plan stages selected" };

  if (campaign.jobs.length > 0) {
    // resume: keep succeeded stages, reset failed ones and queue any
    // selected stages that have no job record yet (generate-remaining).
    await updateDb((d) => {
      const c = d.campaigns.find((x) => x.id === id);
      if (!c) return;
      for (const j of c.jobs) {
        if (j.status === "failed" && wanted.includes(j.stageId)) {
          if (capabilityOverride?.trim()) j.capability = capabilityOverride.trim();
          j.status = "queued";
          j.error = undefined;
        }
      }
      const covered = new Set(c.jobs.map((j) => j.stageId));
      for (const stageId of wanted) {
        if (covered.has(stageId)) continue;
        const stage = campaign.preflight?.plan.find((s) => s.id === stageId);
        if (!stage) continue;
        c.jobs.push({
          id: newId("job"),
          campaignId: id,
          stageId: stage.id,
          kind: stage.kind,
          capability: capabilityOverride?.trim() || stage.capability,
          prompt: composeStagePrompt(campaign, stage.id),
          requestMeta: requestMetaFor(stage),
          status: "queued",
          startedAt: nowIso()
        });
      }
      c.status = "generating";
      c.updatedAt = nowIso();
    });
  } else {
    const jobs = createJobRecords(campaign, wanted);
    await updateDb((d) => {
      const c = d.campaigns.find((x) => x.id === id);
      if (c) {
        c.jobs = jobs;
        c.status = "generating";
        c.updatedAt = nowIso();
      }
    });
  }
  // background execution of exactly the selected stages; UI polls GET /api/campaigns/[id] for progress
  void runProduction(id, wanted).catch(() => undefined);
  await updateDb((d) => {
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "production.start",
      summary: `Livepeer production started for "${campaign.title}" — only preflight-approved stages may run.`,
      refs: [id]
    });
  });
  return { started: true };
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

  const revised: ProductionJob = {
    id: newId("job"),
    campaignId: id,
    stageId,
    kind: stage.kind,
    capability: stage.capability,
    prompt: `${composeStagePrompt(campaign, stageId)} Reviewer refinement: ${instructions.trim()}`,
    requestMeta: requestMetaFor(stage),
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
  // Queue only the target job; the stage filter makes runProduction skip
  // everything else without touching it (no more marking queued stages
  // succeeded just to skip them).
  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === campaignId);
    if (!c) return;
    const target = c.jobs.find((j) => j.id === jobId);
    if (target) target.status = "queued";
    c.status = "generating";
  });
  const target = (await loadCampaign(campaignId))?.jobs.find((j) => j.id === jobId);
  await runProduction(campaignId, target ? [target.stageId] : []);
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
  const result = await publishCampaignRecord(id);
  await updateDb((d) => {
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "campaign.approved",
      summary: `Campaign pack approved for "${campaign.title}".`,
      refs: [id]
    });
  });
  // Public verification snapshot: sanitized, stable reference, written at
  // approval time. Snapshot failures never undo the approval itself.
  let verificationRef: string | undefined;
  let verificationWarning: string | undefined;
  try {
    const fresh = await loadCampaign(id);
    if (fresh) {
      const db = await loadDb();
      verificationRef = fresh.verificationRef ?? newVerificationRef();
      await saveVerificationSnapshot(
        buildPublicSnapshot({
          ref: verificationRef,
          campaign: fresh,
          passport: db.passports.find((p) => p.id === fresh.passportId) ?? null,
          facts: db.productFacts.find((f) => f.id === fresh.productFactsId) ?? null
        })
      );
      await updateDb((d) => {
        const c = d.campaigns.find((x) => x.id === id);
        if (c) {
          c.verificationRef = verificationRef;
          c.updatedAt = nowIso();
        }
      });
    }
  } catch {
    verificationWarning = "Approved, but the public verification snapshot failed to save — approve again to retry.";
  }
  return { approved: true, ual: result.ual, publicationStatus: result.publicationStatus, verificationRef, verificationWarning };
}

/**
 * Hard-delete a campaign. Owner-only. Allowed solely for workspace-local
 * drafts (see deletionEligibility): the row, jobs, receipts and plan are
 * removed, a tombstone is recorded (idempotent retries succeed), activity
 * events stay, and DKG state is never touched — deletable campaigns have no
 * public proof by construction.
 */
export async function deleteCampaign(id: string): Promise<{ deleted: true; alreadyDeleted: boolean; title: string }> {
  await requireWorkspaceOwner();
  const tombstoned = isDeleted(await loadDb(), id);
  if (tombstoned) {
    const title = deletedTitle(await loadDb(), id) ?? id;
    return { deleted: true, alreadyDeleted: true, title };
  }
  const campaign = await loadCampaign(id);
  if (!campaign) throw new CampaignNotFoundError(id);
  const eligibility = deletionEligibility(campaign);
  if (!eligibility.deletable) {
    throw new CampaignProtectedError(eligibility.reasons, eligibility.archiveAvailable);
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
