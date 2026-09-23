import type { Campaign, Database, DerivativeReceipt } from "../types";
import { newId, nowIso, sha256 } from "../store";
import { throwIfArchived } from "../campaign-lifecycle";
import { readWorkspace, writeWorkspace } from "./run-store";
import { withCampaignLock } from "./mutex";
import { LivepeerMcpClient, livepeerConfig } from "./mcp-client";
import { isUsableOutputUrl } from "./plan-dag";
import { aspectVerdict } from "./aspect";
import { redactSecrets } from "../dkg/edge-node-adapter";
import {
  captionRecoveryError,
  isCaptionStale,
  isTerminalCaptionStatus,
  OUTCOME_UNKNOWN_COPY,
  RECOVERY_CONFLICT_MESSAGE,
  validateCaptionLanguage,
  type FilmCaptionJob,
  type FilmCaptionStatus,
  type TranscribeParsed
} from "./film-captions";
import type { FilmRun } from "./film-run";

/**
 * Burn-captions finishing execution: one durable caption job per explicit
 * user confirmation, run against the completed reel through `transcribe`
 * only. The original reel is never overwritten - a playable captioned
 * file becomes a NEW local-only derivative receipt linked to the reel
 * (no DKG publication, no storage claims). Transcript-only responses store
 * the transcript as metadata and never claim burned captions. Short-clip
 * jobs, receipts, runs, and plans are never read or written.
 */

/** Minimal provider surface (LivepeerMcpClient satisfies it structurally). */
export interface FilmCaptionClient {
  transcribeForCaptions(input: { sourceUrl: string; language: string }): Promise<TranscribeParsed>;
  cancelProviderJob(jobId: string): Promise<{ cancelled: boolean; note: string }>;
}

export interface CaptionSubmitResult {
  job?: FilmCaptionJob;
  created: boolean;
  error?: string;
}

export interface CaptionPumpResult {
  pumped: boolean;
  reason?: string;
}

const pumpLocks = new Map<string, boolean>();

function defaultClient(): FilmCaptionClient {
  return new LivepeerMcpClient(livepeerConfig());
}

function logCaption(scope: string, raw: unknown): void {
  const message = raw instanceof Error ? raw.message : String(raw ?? "");
  console.error(`[film-caption:${scope}]`, redactSecrets(message).slice(0, 500));
}

function findRun(campaign: Campaign, filmRunId: string): FilmRun | undefined {
  return campaign.filmRuns?.find((r) => r.id === filmRunId);
}

function findCaptionJob(campaign: Campaign, filmRunId: string, captionJobId: string): FilmCaptionJob | undefined {
  return findRun(campaign, filmRunId)?.captionJobs?.find((j) => j.id === captionJobId);
}

function activeCaptionJob(run: FilmRun): FilmCaptionJob | undefined {
  return [...(run.captionJobs ?? [])].reverse().find((j) => !isTerminalCaptionStatus(j.status));
}

/**
 * Submit a caption job: eligibility (completed reel with a durable HTTPS
 * URL, allow verdict, explicit language) then one durable queued record.
 * Returns fast; the pump executes. Repeats with the same idempotency key
 * replay the existing job; a second submit while one is active returns the
 * active job instead of a duplicate paid call.
 */
export async function submitCaptionJob(input: {
  workspaceId: string;
  campaignId: string;
  filmRunId: string;
  language: unknown;
  idempotencyKey?: string;
}): Promise<CaptionSubmitResult> {
  const db = await readWorkspace(input.workspaceId);
  const campaign = db.campaigns.find((c) => c.id === input.campaignId);
  if (!campaign) return { created: false, error: "Campaign not found" };
  try {
    throwIfArchived(campaign, "caption-submitted");
  } catch (e) {
    return { created: false, error: e instanceof Error ? e.message : "Archived campaigns are read-only." };
  }
  if (campaign.preflight?.decision !== "allow") {
    return { created: false, error: "Resolve the rights block before finishing a film - blocked campaigns never reach generation." };
  }
  const run = findRun(campaign, input.filmRunId);
  if (!run) return { created: false, error: "Film run not found." };
  if (run.status !== "ready" || !isUsableOutputUrl(run.reelUrl)) {
    return { created: false, error: "Burn captions needs a completed film reel - this run has not delivered one yet." };
  }
  const checked = validateCaptionLanguage(input.language);
  if (!checked.ok) return { created: false, error: checked.error };
  const key = input.idempotencyKey?.trim() || undefined;
  if (key) {
    const replay = run.captionJobs?.find((j) => j.idempotencyKey === key);
    if (replay) return { job: replay, created: false };
  }
  const active = activeCaptionJob(run);
  if (active) return { job: active, created: false };
  const now = nowIso();
  const job: FilmCaptionJob = {
    id: newId("filmcap"),
    campaignId: input.campaignId,
    filmRunId: input.filmRunId,
    language: checked.language,
    sourceReelUrl: run.reelUrl as string,
    status: "queued",
    attempt: 1,
    ...(key ? { idempotencyKey: key } : {}),
    createdAt: now,
    updatedAt: now
  };
  await withCampaignLock(input.campaignId, () =>
    writeWorkspace(input.workspaceId, (d: Database) => {
      const r = d.campaigns.find((x) => x.id === input.campaignId)?.filmRuns?.find((x) => x.id === input.filmRunId);
      if (!r) return;
      r.captionJobs = [...(r.captionJobs ?? []), job];
      const c = d.campaigns.find((x) => x.id === input.campaignId);
      if (c) c.updatedAt = nowIso();
      d.events.push({
        id: newId("evt"),
        at: nowIso(),
        kind: "film-caption.submit",
        summary: `Caption job ${job.id} queued for "${r.filmTitle}" (${checked.language}). The original reel is untouched; a captioned derivative is created only if the provider returns one.`,
        refs: [input.campaignId, input.filmRunId, job.id]
      });
    })
  );
  return { job, created: true };
}

async function writeCaptionJob(
  workspaceId: string,
  campaignId: string,
  filmRunId: string,
  captionJobId: string,
  mutate: (job: FilmCaptionJob) => void
): Promise<FilmCaptionJob | undefined> {
  let out: FilmCaptionJob | undefined;
  await withCampaignLock(campaignId, () =>
    writeWorkspace(workspaceId, (d: Database) => {
      const job = d.campaigns
        .find((x) => x.id === campaignId)
        ?.filmRuns?.find((x) => x.id === filmRunId)
        ?.captionJobs?.find((x) => x.id === captionJobId);
      if (!job) return;
      mutate(job);
      job.updatedAt = nowIso();
      out = { ...job };
    })
  );
  return out;
}

async function failCaptionJob(
  workspaceId: string,
  campaignId: string,
  filmRunId: string,
  captionJobId: string,
  error: string,
  transcriptText?: string,
  providerJobId?: string
): Promise<void> {
  await writeCaptionJob(workspaceId, campaignId, filmRunId, captionJobId, (job) => {
    if (job.status === "ready" || job.status === "cancelled") return;
    job.status = "failed";
    job.error = error;
    if (transcriptText !== undefined) job.transcriptText = transcriptText;
    if (providerJobId !== undefined && !job.providerJobId) job.providerJobId = providerJobId;
    job.finishedAt = nowIso();
  });
}

/**
 * Local-only derivative receipt for a playable captioned file. Never
 * published to DKG, never storage-claimed (provider-hosted, like legacy
 * rows): share surfaces only ever see Ready caption outputs because only
 * they create receipts.
 */
function buildCaptionReceipt(
  campaign: Campaign,
  run: FilmRun,
  job: FilmCaptionJob,
  captionedUrl: string,
  parsed: TranscribeParsed
): DerivativeReceipt {
  const now = nowIso();
  return {
    id: newId("rcpt"),
    campaignId: campaign.id,
    jobId: job.id,
    label: `Campaign film reel · burned captions · ${run.targetDurationSeconds}s`,
    mediaType: "video",
    format: run.aspectRatio,
    outputUrl: captionedUrl,
    ...(parsed.actualWidth !== undefined && parsed.actualHeight !== undefined
      ? { actualWidth: parsed.actualWidth, actualHeight: parsed.actualHeight }
      : {}),
    aspectVerdict: aspectVerdict(run.aspectRatio, parsed.actualWidth, parsed.actualHeight),
    providerUrlFingerprint: sha256(captionedUrl),
    capability: "transcribe",
    promptHash: sha256(`caption:${run.id}:${job.language}:${job.sourceReelUrl}`),
    claimsUsed: [],
    qualityProfile: campaign.request.qualityProfile ?? "balanced",
    role: "subtitle",
    requestedCapability: "transcribe",
    actualCapability: parsed.capability ?? "transcribe",
    ...(parsed.durationSeconds !== undefined ? { durationSeconds: parsed.durationSeconds } : {}),
    requestedDurationSeconds: run.targetDurationSeconds,
    derivedFrom: {
      sourceMediaId: campaign.sourceMediaId,
      passportId: campaign.passportId,
      productFactsId: campaign.productFactsId
    },
    derivedFromFilmRunId: run.id,
    sourceReelUrl: job.sourceReelUrl,
    captionLanguage: job.language,
    preservationRequested: "source-guided-generation",
    preservationEvidenceLevel: "none",
    fallbackReason: "Caption finishing references approved media only in the source reel; no preservation tool ran.",
    providerOperationSucceeded: true,
    ...(parsed.costUsd !== undefined ? { costUsd: parsed.costUsd } : {}),
    generatedAt: now,
    visibility: "private"
  };
}

function safeProviderState(statusText: string): string {
  return /^[a-z0-9_ -]{1,40}$/.test(statusText) ? statusText : "provider-reported failure";
}

/** Apply one transcribe response: ready (linked receipt), burn-pending, transcript-only, or honest failure. */
async function applyTranscribeResponse(
  workspaceId: string,
  campaignId: string,
  campaign: Campaign,
  run: FilmRun,
  job: FilmCaptionJob,
  parsed: TranscribeParsed
): Promise<boolean> {
  const usable = parsed.outputUrl !== undefined && isUsableOutputUrl(parsed.outputUrl);
  if (usable && !parsed.failed) {
    const captionedUrl = parsed.outputUrl as string;
    await withCampaignLock(campaignId, () =>
      writeWorkspace(workspaceId, (d: Database) => {
        const c = d.campaigns.find((x) => x.id === campaignId);
        const target = c?.filmRuns
          ?.find((x) => x.id === run.id)
          ?.captionJobs?.find((x) => x.id === job.id);
        if (!target || target.status === "ready" || target.status === "cancelled") return;
        if (!target.receiptId) {
          const receipt = buildCaptionReceipt(c as Campaign, run, target, captionedUrl, parsed);
          c?.receipts.push(receipt);
          target.receiptId = receipt.id;
          d.events.push({
            id: newId("evt"),
            at: nowIso(),
            kind: "film-caption.ready",
            summary: `Captioned derivative ${receipt.id} ready for "${run.filmTitle}" (${target.language}). Original reel untouched.`,
            refs: [campaignId, run.id, target.id, receipt.id]
          });
        }
        target.status = "ready";
        target.captionedUrl = captionedUrl;
        if (parsed.transcriptText !== undefined) target.transcriptText = parsed.transcriptText;
        if (parsed.providerJobId !== undefined && !target.providerJobId) target.providerJobId = parsed.providerJobId;
        if (parsed.costUsd !== undefined) target.costUsd = parsed.costUsd;
        if (parsed.durationSeconds !== undefined) target.durationSeconds = parsed.durationSeconds;
        if (parsed.actualWidth !== undefined) target.actualWidth = parsed.actualWidth;
        if (parsed.actualHeight !== undefined) target.actualHeight = parsed.actualHeight;
        target.error = undefined;
        target.finishedAt = nowIso();
      })
    );
    return true;
  }
  if (parsed.failed) {
    await failCaptionJob(
      workspaceId,
      campaignId,
      run.id,
      job.id,
      `Caption job failed at the provider (${safeProviderState(parsed.statusText)}). The original reel is intact.`,
      parsed.transcriptText,
      parsed.providerJobId
    );
    return true;
  }
  if (parsed.transcriptText !== undefined && !parsed.burnPending) {
    // Transcript arrived but no playable file: metadata kept, burn never
    // claimed. Recoverable via retry (no provider id tracked) or a fresh
    // confirmation.
    await failCaptionJob(
      workspaceId,
      campaignId,
      run.id,
      job.id,
      "Transcript received; captions were not burned into a video. The original reel is intact.",
      parsed.transcriptText,
      parsed.providerJobId
    );
    return true;
  }
  if (parsed.burnPending) {
    await writeCaptionJob(workspaceId, campaignId, run.id, job.id, (target) => {
      if (target.status === "ready" || target.status === "cancelled" || target.status === "failed") return;
      target.status = "burning";
      if (parsed.transcriptText !== undefined) target.transcriptText = parsed.transcriptText;
      if (parsed.providerJobId !== undefined && !target.providerJobId) target.providerJobId = parsed.providerJobId;
      target.error = undefined;
    });
    return true;
  }
  await failCaptionJob(
    workspaceId,
    campaignId,
    run.id,
    job.id,
    "Caption request returned no usable output - the original reel is intact.",
    parsed.transcriptText,
    parsed.providerJobId
  );
  return true;
}

/**
 * Execute one caption job: dispatch exactly once from queued (pump locks
 * collapse concurrent pumps; retry re-entry only via the retry route,
 * which resets failed-no-id jobs to queued first). Terminal states settle;
 * burn-pending parks honestly (transcribe offers no status check).
 */
export async function pumpCaptionJob(
  workspaceId: string,
  campaignId: string,
  filmRunId: string,
  captionJobId: string,
  client: FilmCaptionClient = defaultClient()
): Promise<CaptionPumpResult> {
  const lockKey = `filmcappump:${captionJobId}`;
  if (pumpLocks.get(lockKey)) return { pumped: false, reason: "already-running" };
  pumpLocks.set(lockKey, true);
  try {
    const db = await readWorkspace(workspaceId);
    const campaign = db.campaigns.find((c) => c.id === campaignId);
    const run = campaign ? findRun(campaign, filmRunId) : undefined;
    const job = campaign ? findCaptionJob(campaign, filmRunId, captionJobId) : undefined;
    if (!campaign || !run || !job) return { pumped: false, reason: "not-found" };
    if (isTerminalCaptionStatus(job.status)) return { pumped: false, reason: "settled" };
    // Interrupted-claim safety first: a stale claimed job may already have
    // been dispatched before a restart - pumping it would risk a duplicate
    // paid call. Only explicit user-confirmed recovery moves it on.
    if (isCaptionStale(job)) return { pumped: false, reason: "stale-claim" };
    if (job.status !== "queued") return { pumped: false, reason: `state-${job.status}` };
    await writeCaptionJob(workspaceId, campaignId, filmRunId, captionJobId, (target) => {
      if (target.status !== "queued") return;
      target.status = "transcribing";
      target.dispatchStartedAt = nowIso();
    });
    let parsed: TranscribeParsed;
    try {
      parsed = await client.transcribeForCaptions({ sourceUrl: job.sourceReelUrl, language: job.language });
    } catch (e) {
      logCaption("transcribe", e);
      await failCaptionJob(
        workspaceId,
        campaignId,
        filmRunId,
        captionJobId,
        "Caption request failed before any output was returned - the original reel is intact. Check the provider before retrying; retrying submits a new job."
      );
      return { pumped: true, reason: "call-failed" };
    }
    const fresh = (await readWorkspace(workspaceId)).campaigns.find((c) => c.id === campaignId);
    const freshRun = fresh ? findRun(fresh, filmRunId) : undefined;
    const freshJob = fresh ? findCaptionJob(fresh, filmRunId, captionJobId) : undefined;
    if (!fresh || !freshRun || !freshJob) return { pumped: false, reason: "not-found" };
    if (isTerminalCaptionStatus(freshJob.status)) return { pumped: true, reason: "settled-elsewhere" };
    await applyTranscribeResponse(workspaceId, campaignId, fresh, freshRun, freshJob, parsed);
    return { pumped: true };
  } finally {
    pumpLocks.delete(lockKey);
  }
}

/**
 * Atomic recovery result: the fresh job is exposed ONLY when the locked
 * branch persisted it. A loser of a concurrent recovery gets ok:false with
 * conflict:true and no job object - never a phantom id to pump.
 */
export type RecoveryWriteResult =
  | { ok: true; job: FilmCaptionJob; recoveredFrom: string }
  | { ok: false; error: string; conflict: boolean };

/**
 * Explicit unknown-outcome recovery: preserve the stale claimed job as a
 * terminal outcome_unknown record (data kept, id never reused), then mint
 * a FRESH caption job with a fresh idempotency key. Only the new job is
 * submitted - this is not a retry of a known-unsubmitted request. The
 * caller fires the detached pump for the returned job id.
 *
 * Concurrency: the pre-lock read gives specific errors cheaply, but the
 * in-lock re-check is authoritative. The fresh job is constructed INSIDE
 * the successful locked branch; if the original changed concurrently, the
 * branch writes nothing (no job, no event) and the caller gets a
 * conflict - the route answers 409 and pumps nothing.
 */
export async function recoverCaptionJob(
  workspaceId: string,
  campaignId: string,
  filmRunId: string,
  captionJobId: string,
  nowMs: number = Date.now()
): Promise<RecoveryWriteResult> {
  const db = await readWorkspace(workspaceId);
  const campaign = db.campaigns.find((c) => c.id === campaignId);
  const run = campaign ? findRun(campaign, filmRunId) : undefined;
  const job = campaign ? findCaptionJob(campaign, filmRunId, captionJobId) : undefined;
  if (!campaign || !run || !job) return { ok: false, error: "Caption job not found.", conflict: false };
  const blocked = captionRecoveryError(job, nowMs);
  if (blocked) return { ok: false, error: blocked, conflict: false };
  const now = nowIso();
  let written: FilmCaptionJob | undefined;
  await withCampaignLock(campaignId, () =>
    writeWorkspace(workspaceId, (d: Database) => {
      const owner = d.campaigns.find((x) => x.id === campaignId)?.filmRuns?.find((x) => x.id === filmRunId);
      const target = owner?.captionJobs?.find((x) => x.id === captionJobId);
      // Authoritative re-check: a concurrent recovery may have preserved
      // this record already. On any failure write nothing at all.
      if (!owner || !target || captionRecoveryError(target, nowMs)) return;
      const fresh: FilmCaptionJob = {
        id: newId("filmcap"),
        campaignId,
        filmRunId,
        language: target.language,
        sourceReelUrl: target.sourceReelUrl,
        status: "queued",
        attempt: 1,
        idempotencyKey: newId("filmcap"),
        createdAt: now,
        updatedAt: now
      };
      // Preserve first: terminal outcome-unknown record, data intact.
      target.status = "outcome_unknown";
      target.outcomeUnknownAt = now;
      target.error = OUTCOME_UNKNOWN_COPY;
      target.finishedAt = now;
      owner.captionJobs = [...(owner.captionJobs ?? []), { ...fresh }];
      const c = d.campaigns.find((x) => x.id === campaignId);
      if (c) c.updatedAt = now;
      d.events.push({
        id: newId("evt"),
        at: now,
        kind: "film-caption.recover",
        summary: `Caption job ${target.id} preserved as outcome-unknown (no recorded result); fresh request ${fresh.id} queued. Original reel unchanged.`,
        refs: [campaignId, filmRunId, target.id, fresh.id]
      });
      written = { ...fresh };
    })
  );
  if (!written) return { ok: false, error: RECOVERY_CONFLICT_MESSAGE, conflict: true };
  return { ok: true, job: written, recoveredFrom: captionJobId };
}

/** HTTP mapping for recovery outcomes (pure): conflicts answer 409 with the stable message. */
export function recoverHttpOutcome(result: RecoveryWriteResult): {
  status: 200 | 400 | 409;
  body: Record<string, unknown>;
} {
  if (result.ok) {
    return { status: 200, body: { ok: true, captionJobId: result.job.id, recoveredFrom: result.recoveredFrom } };
  }
  if (result.conflict) return { status: 409, body: { error: RECOVERY_CONFLICT_MESSAGE } };
  return { status: 400, body: { error: result.error } };
}

/** Read-only record lookup for the status route (never dispatches - GETs stay provider-free). */
export function findCaptionJobView(
  campaign: Campaign,
  filmRunId: string,
  captionJobId: string
): FilmCaptionJob | undefined {
  const job = findCaptionJob(campaign, filmRunId, captionJobId);
  return job ? { ...job } : undefined;
}

/**
 * Cancel one caption job: best-effort provider cancel of the tracked id
 * only, then local terminal marking. The reel, receipts, and all other
 * campaign state are never touched.
 */
export async function cancelCaptionJob(
  workspaceId: string,
  campaignId: string,
  filmRunId: string,
  captionJobId: string,
  client: FilmCaptionClient = defaultClient()
): Promise<{ cancelled: boolean; providerConfirmed: boolean; note: string }> {
  const db = await readWorkspace(workspaceId);
  const campaign = db.campaigns.find((c) => c.id === campaignId);
  const job = campaign ? findCaptionJob(campaign, filmRunId, captionJobId) : undefined;
  if (!job) return { cancelled: false, providerConfirmed: false, note: "Caption job not found." };
  if (job.status === "ready") {
    return { cancelled: false, providerConfirmed: false, note: "Captioned output already delivered - nothing to cancel." };
  }
  if (job.status === "failed" || job.status === "cancelled") {
    return { cancelled: false, providerConfirmed: job.providerCancelConfirmed ?? false, note: `Caption job already ${job.status}.` };
  }
  let providerConfirmed = false;
  let providerNote = "No provider job was tracked - nothing was submitted.";
  if (job.providerJobId) {
    try {
      const result = await client.cancelProviderJob(job.providerJobId);
      providerConfirmed = result.cancelled;
      providerNote = result.note;
    } catch (e) {
      logCaption("cancel", e);
      providerNote = "Provider cancel call failed - the job is marked cancelled locally; verify at the provider.";
    }
  }
  await writeCaptionJob(workspaceId, campaignId, filmRunId, captionJobId, (target) => {
    if (target.status === "ready") return;
    target.status = "cancelled";
    target.providerCancelConfirmed = providerConfirmed;
    target.providerCancelNote = providerNote;
    target.finishedAt = nowIso();
  });
  return {
    cancelled: true,
    providerConfirmed,
    note: providerConfirmed
      ? "Caption job cancelled; provider confirmed. The original reel is untouched."
      : `Caption job cancelled locally. ${providerNote} The original reel is untouched.`
  };
}

export type { FilmCaptionStatus };
export type { FilmCaptionJob };
