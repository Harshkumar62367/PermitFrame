import type { Campaign, CampaignRequest, Platform, PublicationStatus } from "./types";
import { hasSharableReceipt, isPublicDeliverableReceipt } from "./types";
import { loadDb, newId, nowIso, updateDb } from "./store";
import { eq } from "drizzle-orm";
import { getDb } from "./db/client";
import { workspaces } from "./db/schema";
import { requireCurrentSession } from "./auth";
import { preflight } from "./policy/engine";
import {
  revalidateCampaignAuthorization,
  type AuthorizationRevalidation
} from "./policy/authorization";
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
import { publishCampaignRecord } from "./livepeer/pipeline";

/**
 * Campaign lifecycle: reads, creation (idempotent), brief edits,
 * rights re-checks, approval, verification links, deletion, and archiving.
 * Owns campaign state transitions and audit events. Depends on leaf
 * server modules only - never on template application, production, or
 * variations (those import the shared guards from here).
 */

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

export type ApprovalEligibility = { ok: true } | { ok: false; error: string };

/**
 * Pure approval-gate composition (unit-tested): effective verdict,
 * current exact authorization, complete-pack readiness, production
 * readiness, durable identity, aspect honesty, and at least one public
 * deliverable output. String copies match the historical messages
 * byte-for-byte. approveCampaign supplies live evidence; tests supply
 * fixtures.
 */
export function checkApprovalEligibility(
  campaign: Pick<Campaign, "status" | "preflight" | "jobs" | "receipts" | "passportId">,
  auth: AuthorizationRevalidation
): ApprovalEligibility {
  // Gate on the effective verdict, not the stored label: a stale "draft" row
  // whose preflight denies must never be approvable.
  if (effectiveCampaignStatus(campaign) === "blocked") {
    return { ok: false, error: "Blocked campaigns cannot be approved" };
  }
  if (!auth.ok) return { ok: false, error: auth.error };
  // The authorization must bind THIS campaign's current selection: an
  // approval computed for an earlier selection (different passport) never
  // finalizes, even if that evidence was once valid.
  if (auth.passport.id !== campaign.passportId) {
    return {
      ok: false,
      error: "Authorization does not match the current campaign selection - re-check permissions before approving."
    };
  }
  // Complete-pack readiness: every job belonging to the active preflight
  // plan must be genuinely ready for delivery. One ready receipt is never
  // permission to approve an incomplete pack - queued, generating,
  // previewed, pending, retryable, failed, or cancelled planned jobs block
  // with their stages named. Jobs outside the active plan (legacy rows from
  // retired plans) never block. Stages with no job at all have not been
  // produced and block the same way.
  const plan = campaign.preflight?.plan ?? [];
  const unready: string[] = [];
  for (const stage of plan) {
    const stageJobs = campaign.jobs.filter((j) => j.stageId === stage.id);
    if (stageJobs.length === 0) {
      unready.push(`“${stage.label || stage.id}” (not produced)`);
      continue;
    }
    const pending = stageJobs.find((j) => j.status !== "ready_to_share");
    if (pending) unready.push(`“${stage.label || stage.id}” (${pending.status})`);
  }
  if (unready.length > 0) {
    const names = unready.join("; ").slice(0, 220);
    return {
      ok: false,
      error: `Cannot approve - ${unready.length} planned stage${unready.length === 1 ? " is" : "s are"} not ready: ${names}. Wait for completion or regenerate before approving.`
    };
  }
  if (campaign.jobs.filter((j) => j.status === "ready_to_share").length === 0) {
    return { ok: false, error: "Produce the campaign pack before approving - previews and unsaved outputs cannot be signed off yet" };
  }
  // Proof needs durable identity: provider-hosted legacy outputs must be
  // stored securely first — approval publishes evidence, never previews.
  if (!campaign.receipts.some((r) => hasSharableReceipt(r))) {
    return { ok: false, error: "Store outputs securely before approving - provider-hosted legacy assets cannot be published as proof yet" };
  }
  // Aspect honesty: a stored output whose measured file differs from the
  // requested placement is never Ready for that placement. Name the stages
  // and point at the explicit regenerate action — nothing auto-retries.
  const mismatched = campaign.receipts.filter((r) => !r.supersededAt && hasSharableReceipt(r) && r.aspectVerdict === "mismatch");
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
      ok: false,
      error: `Aspect check failed - ${names}. Regenerate the listed stage${mismatched.length === 1 ? "" : "s"} for the planned placement, then approve.`
    };
  }
  // Fidelity honesty: an output whose identity check failed is never
  // Ready, even when the rest of the pack is. Any failed preservation
  // blocks the whole pack until the listed stage is regenerated - a
  // replacement image was never generated, so there is nothing to approve.
  const fidelityFailed = campaign.receipts.filter((r) => r.deliveryBlocked === "fidelity_check_failed");
  if (fidelityFailed.length > 0) {
    const names = fidelityFailed
      .map((r) => `“${r.label}”`)
      .join("; ")
      .slice(0, 220);
    return {
      ok: false,
      error: `Fidelity check failed - ${names}. Could not preserve the approved product/property. No replacement image was generated. Regenerate the listed stage${fidelityFailed.length === 1 ? "" : "s"}, then approve.`
    };
  }
  // Public deliverability: at least one output must be non-private, durably
  // stored, and unblocked. A pack whose only outputs are private
  // derivatives (narration, captions) approves nothing public.
  if (!campaign.receipts.some((r) => isPublicDeliverableReceipt(r))) {
    return {
      ok: false,
      error: "Only deliverable shared outputs can be approved - private, blocked, or not-yet-stored outputs cannot be signed off."
    };
  }
  return { ok: true };
}

export async function approveCampaign(id: string): Promise<{ approved: boolean; ual?: string; publicationStatus?: PublicationStatus; verificationRef?: string; verificationWarning?: string; error?: string }> {
  // Single fresh workspace read: the campaign object below feeds
  // authorization revalidation, approval eligibility, the status
  // transition, and snapshot construction - an earlier snapshot is never
  // authorized while a newer one is mutated.
  const db = await loadDb();
  const campaign = db.campaigns.find((c) => c.id === id);
  if (!campaign) return { approved: false, error: "Campaign not found" };
  try {
    throwIfArchived(campaign, "approved");
  } catch (e) {
    return { approved: false, error: e instanceof Error ? e.message : "Archived campaigns are read-only." };
  }
  // Finalization belongs to the workspace owner: any other session -
  // including an anonymous share-link reviewer - can only record feedback,
  // never approve. The error is owner-specific (not the delete/archive one).
  try {
    await requireWorkspaceOwner();
  } catch (e) {
    if (e instanceof WorkspaceOwnerRequiredError) {
      return { approved: false, error: "Only the workspace owner may approve campaigns." };
    }
    throw e;
  }
  // Current authorization + delivery eligibility, evaluated now - never the
  // saved preflight label alone. loadDb() above already resolved the same
  // workspace the campaign came from.
  const auth = await revalidateCampaignAuthorization(campaign, db);
  const eligibility = checkApprovalEligibility(campaign, auth);
  if (!eligibility.ok) return { approved: false, error: eligibility.error };
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
      // One read for the post-publish snapshot: campaign, passport, and
      // facts all resolve from the same fresh database state.
      const snapshotDb = await loadDb();
      const fresh = snapshotDb.campaigns.find((c) => c.id === id);
      if (fresh) {
        // Versioned snapshots: every approval mints a fresh ref, so prior
        // published snapshots are never overwritten and stay retrievable
        // under their own URLs. The campaign points at the latest.
        const ref = newVerificationRef();
        await saveVerificationSnapshot(
          buildPublicSnapshot({
            ref,
            campaign: fresh,
            passport: snapshotDb.passports.find((p) => p.id === fresh.passportId) ?? null,
            facts: snapshotDb.productFacts.find((f) => f.id === fresh.productFactsId) ?? null
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
  const db = await loadDb();
  const campaign = db.campaigns.find((c) => c.id === id);
  if (!campaign) throw new CampaignNotFoundError(id);
  if (campaign.status !== "approved") {
    throw new CampaignProtectedError(["Only approved campaign packs can receive a verification link."], false);
  }
  // Versioned snapshots: a refresh mints a fresh ref like every approval -
  // prior snapshots are never overwritten and stay retrievable. `created`
  // still reports whether this campaign had a link before.
  const ref = newVerificationRef();
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
