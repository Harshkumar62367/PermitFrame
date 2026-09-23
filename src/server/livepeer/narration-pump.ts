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
  buildMuxRequest,
  buildTtsRequest,
  checkNarrationFitsReel,
  isNarrationStale,
  isTerminalNarrationStatus,
  NARRATION_OUTCOME_UNKNOWN_COPY,
  NARRATION_RECOVERY_CONFLICT_MESSAGE,
  narrationMuxBudget,
  narrationRecoveryError,
  safePhaseState,
  validateNarrationCap,
  validateNarrationScript,
  type FilmNarrationJob,
  type ProviderRefParsed
} from "./narration-policy";
import type { FilmRun } from "./film-run";

/**
 * Narrated-reel finishing execution: one durable narration job per
 * explicit user confirmation, run as TTS-then-mux through create_media
 * only (audio-contract.ts gates both dispatches). The original reel is
 * never overwritten - a playable narrated file becomes a NEW local-only
 * derivative receipt linked to the reel (no DKG publication, no storage
 * claims). Narration never loops (audio_fill none), and muxing waits for
 * a verified audio file plus a known remaining cap. Short-clip jobs,
 * caption jobs, receipts, and plans are never read or written here.
 */

/** Minimal provider surface (LivepeerMcpClient satisfies it structurally). */
export interface FilmNarrationClient {
  submitNarrationTts(input: { prompt: string; sessionId: string; idempotencyKey: string; maxCostUsd: number; excludeUrls?: string[] }): Promise<ProviderRefParsed>;
  submitMuxAudio(input: { sourceUrl: string; audioUrl: string; sessionId: string; idempotencyKey: string; maxCostUsd: number }): Promise<ProviderRefParsed>;
  getMediaStatus(jobId: string): Promise<import("./mcp-client").MediaStatusResult>;
  cancelProviderJob(jobId: string): Promise<{ cancelled: boolean; note: string }>;
}

export interface NarrationSubmitResult {
  job?: FilmNarrationJob;
  created: boolean;
  error?: string;
}

export interface NarrationPumpResult {
  pumped: boolean;
  reason?: string;
}

export type NarrationRecoveryResult =
  | { ok: true; job: FilmNarrationJob; recoveredFrom: string }
  | { ok: false; error: string; conflict: boolean };

const pumpLocks = new Map<string, boolean>();

// Single-process optimization only: correctness across processes and
// restarts comes from the locked durable claim helpers
// (claimTtsDispatch/claimMuxDispatch), never from this map.

function defaultClient(): FilmNarrationClient {
  return new LivepeerMcpClient(livepeerConfig());
}

function logNarration(scope: string, raw: unknown): void {
  const message = raw instanceof Error ? raw.message : String(raw ?? "");
  console.error(`[film-narration:${scope}]`, redactSecrets(message).slice(0, 500));
}

function findRun(campaign: Campaign, filmRunId: string): FilmRun | undefined {
  return campaign.filmRuns?.find((r) => r.id === filmRunId);
}

function findNarrationJob(campaign: Campaign, filmRunId: string, narrationJobId: string): FilmNarrationJob | undefined {
  return findRun(campaign, filmRunId)?.narrationJobs?.find((j) => j.id === narrationJobId);
}

function activeNarrationJob(run: FilmRun): FilmNarrationJob | undefined {
  return [...(run.narrationJobs ?? [])].reverse().find((j) => !isTerminalNarrationStatus(j.status));
}

function ttsSessionId(jobId: string): string {
  return `${jobId}-tts`;
}

function muxSessionId(jobId: string): string {
  return `${jobId}-mux`;
}

/**
 * Submit a narration job: eligibility (completed reel with a durable
 * HTTPS URL, allow verdict), validated script + reel fit + positive cap,
 * then one durable queued record. Returns fast; the pump executes.
 * Repeats with the same idempotency key replay the existing job; a
 * second submit while one is active returns the active job instead of
 * parallel paid flows.
 */
export async function submitNarrationJob(input: {
  workspaceId: string;
  campaignId: string;
  filmRunId: string;
  script: unknown;
  narrationCapUsd: unknown;
  idempotencyKey?: string;
}): Promise<NarrationSubmitResult> {
  const db = await readWorkspace(input.workspaceId);
  const campaign = db.campaigns.find((c) => c.id === input.campaignId);
  if (!campaign) return { created: false, error: "Campaign not found" };
  try {
    throwIfArchived(campaign, "narration-submitted");
  } catch (e) {
    return { created: false, error: e instanceof Error ? e.message : "Archived campaigns are read-only." };
  }
  if (campaign.preflight?.decision !== "allow") {
    return { created: false, error: "Resolve the rights block before finishing a film - blocked campaigns never reach generation." };
  }
  const run = findRun(campaign, input.filmRunId);
  if (!run) return { created: false, error: "Film run not found." };
  if (run.status !== "ready" || !isUsableOutputUrl(run.reelUrl)) {
    return { created: false, error: "Add narration needs a completed film reel - this run has not delivered one yet." };
  }
  const scripted = validateNarrationScript(input.script);
  if (!scripted.ok) return { created: false, error: scripted.error };
  const fit = checkNarrationFitsReel(scripted.estimatedSeconds, run.targetDurationSeconds);
  if (fit) return { created: false, error: fit };
  const capped = validateNarrationCap(input.narrationCapUsd);
  if (!capped.ok) return { created: false, error: capped.error };
  const key = input.idempotencyKey?.trim() || undefined;
  if (key) {
    const replay = run.narrationJobs?.find((j) => j.idempotencyKey === key);
    if (replay) return { job: replay, created: false };
  }
  const active = activeNarrationJob(run);
  if (active) return { job: active, created: false };
  const now = nowIso();
  const job: FilmNarrationJob = {
    id: newId("filmnar"),
    campaignId: input.campaignId,
    filmRunId: input.filmRunId,
    script: scripted.script,
    scriptHash: sha256(scripted.script),
    estimatedSeconds: scripted.estimatedSeconds,
    narrationCapUsd: capped.capUsd,
    sourceReelUrl: run.reelUrl as string,
    status: "queued",
    ttsIdempotencyKey: newId("tts"),
    muxIdempotencyKey: newId("mux"),
    attempt: 1,
    ...(key ? { idempotencyKey: key } : {}),
    createdAt: now,
    updatedAt: now
  };
  await withCampaignLock(input.campaignId, () =>
    writeWorkspace(input.workspaceId, (d: Database) => {
      const r = d.campaigns.find((x) => x.id === input.campaignId)?.filmRuns?.find((x) => x.id === input.filmRunId);
      if (!r) return;
      r.narrationJobs = [...(r.narrationJobs ?? []), job];
      const c = d.campaigns.find((x) => x.id === input.campaignId);
      if (c) c.updatedAt = nowIso();
      d.events.push({
        id: newId("evt"),
        at: nowIso(),
        kind: "film-narration.submit",
        summary: `Narration job ${job.id} queued for "${r.filmTitle}" (cap $${job.narrationCapUsd.toFixed(2)} maximum, ~${job.estimatedSeconds}s estimated). The original reel is untouched; a narrated derivative is created only if the provider returns one.`,
        refs: [input.campaignId, input.filmRunId, job.id]
      });
    })
  );
  return { job, created: true };
}

async function writeNarrationJob(
  workspaceId: string,
  campaignId: string,
  filmRunId: string,
  narrationJobId: string,
  mutate: (job: FilmNarrationJob) => void
): Promise<FilmNarrationJob | undefined> {
  let out: FilmNarrationJob | undefined;
  await withCampaignLock(campaignId, () =>
    writeWorkspace(workspaceId, (d: Database) => {
      const job = d.campaigns
        .find((x) => x.id === campaignId)
        ?.filmRuns?.find((x) => x.id === filmRunId)
        ?.narrationJobs?.find((x) => x.id === narrationJobId);
      if (!job) return;
      mutate(job);
      job.updatedAt = nowIso();
      out = { ...job };
    })
  );
  return out;
}

async function failNarrationJob(
  workspaceId: string,
  campaignId: string,
  filmRunId: string,
  narrationJobId: string,
  error: string
): Promise<void> {
  await writeNarrationJob(workspaceId, campaignId, filmRunId, narrationJobId, (job) => {
    if (job.status === "ready" || job.status === "cancelled" || job.status === "outcome_unknown") return;
    job.status = "failed";
    job.error = error;
    job.finishedAt = nowIso();
  });
}

/**
 * Local-only derivative receipt for a playable narrated file. Never
 * published to DKG, never storage-claimed. The narration script (and any
 * transcript-like text) stays out of receipts, events, and share data -
 * only the run/reel linkage and the language-neutral label travel.
 */
function buildNarratedReceipt(
  campaign: Campaign,
  run: FilmRun,
  job: FilmNarrationJob,
  narratedUrl: string,
  capability: string | undefined,
  actualWidth: number | undefined,
  actualHeight: number | undefined,
  durationSeconds: number | undefined,
  costUsd: number | undefined
): DerivativeReceipt {
  const now = nowIso();
  return {
    id: newId("rcpt"),
    campaignId: campaign.id,
    jobId: job.id,
    label: `Campaign film reel · narration · ${run.targetDurationSeconds}s`,
    mediaType: "video",
    format: run.aspectRatio,
    outputUrl: narratedUrl,
    ...(actualWidth !== undefined && actualHeight !== undefined
      ? { actualWidth, actualHeight }
      : {}),
    aspectVerdict: aspectVerdict(run.aspectRatio, actualWidth, actualHeight),
    providerUrlFingerprint: sha256(narratedUrl),
    capability: "mux_audio",
    promptHash: sha256(`narration:${run.id}:${job.scriptHash}:${job.narrationCapUsd}`),
    claimsUsed: [],
    qualityProfile: campaign.request.qualityProfile ?? "balanced",
    role: "tts",
    requestedCapability: "mux_audio",
    actualCapability: capability ?? "mux_audio",
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    requestedDurationSeconds: run.targetDurationSeconds,
    derivedFrom: {
      sourceMediaId: campaign.sourceMediaId,
      passportId: campaign.passportId,
      productFactsId: campaign.productFactsId
    },
    derivedFromFilmRunId: run.id,
    sourceReelUrl: job.sourceReelUrl,
    preservationRequested: "source-guided-generation",
    preservationEvidenceLevel: "none",
    fallbackReason: "Narration finishing references approved media only in the source reel; no preservation tool ran, and no voice identity is claimed.",
    providerOperationSucceeded: true,
    ...(costUsd !== undefined ? { costUsd } : {}),
    generatedAt: now,
    visibility: "private"
  };
}

/**
 * Atomic dispatch claim result: claimed:true carries a fresh copy of the
 * claimed row and authorizes exactly one provider call. Anything else
 * must make zero provider calls. pumpLocks stays a single-process
 * optimization only - this locked durable transition is the correctness
 * mechanism across processes and restarts.
 */
export type ClaimResult =
  | { claimed: true; job: FilmNarrationJob }
  | { claimed: false; reason: "already-claimed" | "not-found" | "settled" };

/**
 * Atomic TTS claim: only a locked durable transition from queued to
 * generating_narration succeeds, persisting the phase timestamp and the
 * stable TTS idempotency key in the same mutation. Any other state -
 * including an existing claim - returns already-claimed/settled.
 */
export async function claimTtsDispatch(
  workspaceId: string,
  campaignId: string,
  filmRunId: string,
  narrationJobId: string
): Promise<ClaimResult> {
  let result: ClaimResult = { claimed: false, reason: "not-found" };
  await withCampaignLock(campaignId, () =>
    writeWorkspace(workspaceId, (d: Database) => {
      const target = d.campaigns
        .find((x) => x.id === campaignId)
        ?.filmRuns?.find((x) => x.id === filmRunId)
        ?.narrationJobs?.find((x) => x.id === narrationJobId);
      if (!target) {
        result = { claimed: false, reason: "not-found" };
        return;
      }
      if (isTerminalNarrationStatus(target.status)) {
        result = { claimed: false, reason: "settled" };
        return;
      }
      if (target.status !== "queued") {
        result = { claimed: false, reason: "already-claimed" };
        return;
      }
      const now = nowIso();
      target.status = "generating_narration";
      target.ttsDispatchedAt = now;
      target.dispatchStartedAt = target.dispatchStartedAt ?? now;
      target.error = undefined;
      result = { claimed: true, job: { ...target } };
    })
  );
  return result;
}

/**
 * Atomic mux claim: only a locked durable transition from
 * waiting_for_narration with a verified stored narration-audio URL to
 * muxing succeeds, persisting the fresh mux timestamp and the stable mux
 * idempotency key in the same mutation. A row already in muxing is never
 * claimable again.
 */
export async function claimMuxDispatch(
  workspaceId: string,
  campaignId: string,
  filmRunId: string,
  narrationJobId: string
): Promise<ClaimResult> {
  let result: ClaimResult = { claimed: false, reason: "not-found" };
  await withCampaignLock(campaignId, () =>
    writeWorkspace(workspaceId, (d: Database) => {
      const target = d.campaigns
        .find((x) => x.id === campaignId)
        ?.filmRuns?.find((x) => x.id === filmRunId)
        ?.narrationJobs?.find((x) => x.id === narrationJobId);
      if (!target) {
        result = { claimed: false, reason: "not-found" };
        return;
      }
      if (isTerminalNarrationStatus(target.status)) {
        result = { claimed: false, reason: "settled" };
        return;
      }
      if (
        target.status !== "waiting_for_narration" ||
        !target.narrationAudioUrl ||
        !isUsableOutputUrl(target.narrationAudioUrl)
      ) {
        result = { claimed: false, reason: "already-claimed" };
        return;
      }
      const now = nowIso();
      target.status = "muxing";
      target.muxDispatchedAt = now;
      target.dispatchStartedAt = target.dispatchStartedAt ?? now;
      target.error = undefined;
      result = { claimed: true, job: { ...target } };
    })
  );
  return result;
}

/** Dispatch TTS for a queued job (contract-gated) with a durable pre-dispatch claim. */
async function dispatchTts(
  workspaceId: string,
  campaignId: string,
  run: FilmRun,
  job: FilmNarrationJob,
  client: FilmNarrationClient
): Promise<{ ok: true } | { ok: false; error: string }> {
  // 1. Atomic durable claim BEFORE provider contact. Only claimed:true
  // authorizes the single TTS submission below; anything else makes zero
  // provider calls (a missing outcome stays unknown, never "not submitted").
  const claim = await claimTtsDispatch(workspaceId, campaignId, run.id, job.id);
  if (!claim.claimed) return { ok: false, error: `tts-${claim.reason}` };
  const claimed = claim.job;
  let args;
  try {
    args = buildTtsRequest({
      script: claimed.script,
      sessionId: ttsSessionId(claimed.id),
      idempotencyKey: claimed.ttsIdempotencyKey,
      maxCostUsd: claimed.narrationCapUsd
    });
  } catch (e) {
    await failNarrationJob(
      workspaceId,
      campaignId,
      run.id,
      claimed.id,
      e instanceof Error ? e.message : "Narration contract no longer verifies TTS - nothing was dispatched."
    );
    return { ok: false, error: "contract" };
  }
  // 2. Provider contact (the ONLY TTS submission for this job record).
  let parsed;
  try {
    parsed = await client.submitNarrationTts({
      prompt: args.prompt,
      sessionId: args.session_id,
      idempotencyKey: args.idempotency_key,
      maxCostUsd: args.max_cost_usd,
      excludeUrls: [claimed.sourceReelUrl]
    });
  } catch (e) {
    // The request may or may not have reached the provider: the durable
    // claim stands and no outcome is invented.
    logNarration("tts-submit", e);
    return { ok: false, error: "tts-unknown-outcome" };
  }
  if (parsed.failed) {
    await writeNarrationJob(workspaceId, campaignId, run.id, claimed.id, (target) => {
      if (target.status === "ready" || target.status === "cancelled" || target.status === "outcome_unknown") return;
      if (parsed.providerJobId) target.ttsJobId = parsed.providerJobId;
      if (parsed.costUsd !== undefined) target.ttsCostUsd = parsed.costUsd;
      if (parsed.capability) target.actualCapability = parsed.capability;
      target.status = "failed";
      target.error = "Narration generation failed at the provider before delivery. The original reel is intact.";
      target.finishedAt = nowIso();
    });
    return { ok: false, error: "tts-declared-failure" };
  }
  await writeNarrationJob(workspaceId, campaignId, run.id, claimed.id, (target) => {
    if (target.status !== "generating_narration") return;
    if (parsed.providerJobId) target.ttsJobId = parsed.providerJobId;
    if (parsed.costUsd !== undefined) target.ttsCostUsd = parsed.costUsd;
    if (parsed.capability) target.actualCapability = parsed.capability;
    if (parsed.outputUrl && isUsableOutputUrl(parsed.outputUrl)) target.narrationAudioUrl = parsed.outputUrl;
    target.error = undefined;
  });
  if (!parsed.providerJobId && !parsed.outputUrl) {
    // Empty response after a started request: outcome unknown, claim kept.
    return { ok: false, error: "tts-unknown-outcome" };
  }
  return { ok: true };
}

/** Dispatch mux once verified audio and a known remaining cap exist, with a durable pre-dispatch claim. */
async function dispatchMux(
  workspaceId: string,
  campaignId: string,
  run: FilmRun,
  job: FilmNarrationJob,
  audioUrl: string,
  client: FilmNarrationClient
): Promise<{ ok: true } | { ok: false; error: string }> {
  const budget = narrationMuxBudget(job.narrationCapUsd, job.ttsCostUsd);
  if (!budget.ok) {
    await failNarrationJob(workspaceId, campaignId, run.id, job.id, budget.error);
    return { ok: false, error: "cap-exhausted" };
  }
  // 1. Atomic durable mux claim BEFORE provider contact. Only
  // claimed:true authorizes the single mux submission below; an
  // already-muxing row never submits again.
  const claim = await claimMuxDispatch(workspaceId, campaignId, run.id, job.id);
  if (!claim.claimed) return { ok: false, error: `mux-${claim.reason}` };
  const claimed = claim.job;
  let args;
  try {
    args = buildMuxRequest({
      reelUrl: claimed.sourceReelUrl,
      audioUrl,
      sessionId: muxSessionId(claimed.id),
      idempotencyKey: claimed.muxIdempotencyKey,
      maxCostUsd: budget.maxCostUsd
    });
  } catch (e) {
    await failNarrationJob(
      workspaceId,
      campaignId,
      run.id,
      claimed.id,
      e instanceof Error ? e.message : "Narration contract no longer verifies muxing."
    );
    return { ok: false, error: "contract" };
  }
  // 2. Provider contact (the ONLY mux submission for this job record).
  let parsed;
  try {
    parsed = await client.submitMuxAudio({
      sourceUrl: args.source_url,
      audioUrl: args.audio_url,
      sessionId: args.session_id,
      idempotencyKey: args.idempotency_key,
      maxCostUsd: args.max_cost_usd
    });
  } catch (e) {
    // The request may or may not have reached the provider: the mux claim
    // stands and no outcome is invented.
    logNarration("mux-submit", e);
    return { ok: false, error: "mux-unknown-outcome" };
  }
  if (parsed.failed) {
    await writeNarrationJob(workspaceId, campaignId, run.id, job.id, (target) => {
      if (target.status === "ready" || target.status === "cancelled" || target.status === "outcome_unknown") return;
      if (parsed.providerJobId) target.muxJobId = parsed.providerJobId;
      if (parsed.costUsd !== undefined) target.muxCostUsd = parsed.costUsd;
      if (parsed.capability) target.actualCapability = parsed.capability;
      target.status = "failed";
      target.error = "Muxing failed at the provider before delivery. The narration audio is kept and the original reel is intact.";
      target.finishedAt = nowIso();
    });
    return { ok: false, error: "mux-failed" };
  }
  // Record returned ids/cost/capability. Inline output finalizes atomically
  // (receipt + ready in one transaction); otherwise the mux claim stands.
  await writeNarrationJob(workspaceId, campaignId, run.id, job.id, (target) => {
    if (target.status === "ready" || target.status === "cancelled" || target.status === "outcome_unknown") return;
    if (parsed.providerJobId) target.muxJobId = parsed.providerJobId;
    if (parsed.costUsd !== undefined) target.muxCostUsd = parsed.costUsd;
    if (parsed.capability) target.actualCapability = parsed.capability;
  });
  if (parsed.outputUrl && isUsableOutputUrl(parsed.outputUrl)) {
    await finalizeReadyNarration(workspaceId, campaignId, run, job.id, {
      narratedUrl: parsed.outputUrl,
      capability: parsed.capability,
      costUsd: combineCost(job.ttsCostUsd, parsed.costUsd),
      actualWidth: parsed.actualWidth,
      actualHeight: parsed.actualHeight,
      durationSeconds: parsed.durationSeconds
    });
  }
  if (!parsed.providerJobId && !parsed.outputUrl) {
    // Empty response after a started request: outcome unknown, claim kept.
    return { ok: false, error: "mux-unknown-outcome" };
  }
  return { ok: true };
}

/** Apply one TTS poll: audio arrival advances toward mux, terminal failure fails. */
async function applyTtsPoll(
  workspaceId: string,
  campaignId: string,
  run: FilmRun,
  job: FilmNarrationJob,
  status: import("./mcp-client").MediaStatusResult
): Promise<boolean> {
  const audioUsable = status.outputUrl !== undefined && isUsableOutputUrl(status.outputUrl);
  if (status.terminal && audioUsable) {
    await writeNarrationJob(workspaceId, campaignId, run.id, job.id, (target) => {
      if (target.status === "ready" || target.status === "cancelled" || target.status === "outcome_unknown") return;
      target.narrationAudioUrl = status.outputUrl as string;
      if (status.costUsd !== undefined) target.ttsCostUsd = status.costUsd;
      if (status.capability) target.actualCapability = status.capability;
      if (target.ttsJobId === undefined && status.jobId) target.ttsJobId = status.jobId;
      if (target.status === "generating_narration") target.status = "waiting_for_narration";
      target.error = undefined;
    });
    return true;
  }
  if (status.terminal) {
    await failNarrationJob(
      workspaceId,
      campaignId,
      run.id,
      job.id,
      `Narration generation ended (${safePhaseState(status.status || "without audio")}) before delivery. The original reel is intact.`
    );
    return true;
  }
  if (job.status === "generating_narration") {
    await writeNarrationJob(workspaceId, campaignId, run.id, job.id, (target) => {
      if (target.status === "generating_narration") target.status = "waiting_for_narration";
    });
    return true;
  }
  return false;
}

/** Apply one mux poll: usable video finalizes with a linked receipt. */
async function applyMuxPoll(
  workspaceId: string,
  campaign: Campaign,
  run: FilmRun,
  job: FilmNarrationJob,
  status: import("./mcp-client").MediaStatusResult
): Promise<boolean> {
  const videoUsable = status.outputUrl !== undefined && isUsableOutputUrl(status.outputUrl);
  if (status.terminal && videoUsable) {
    const narratedUrl = status.outputUrl as string;
    await finalizeReadyNarration(workspaceId, campaign.id, run, job.id, {
      narratedUrl,
      capability: status.capability,
      costUsd: combineCost(job.ttsCostUsd, status.costUsd)
    });
    await writeNarrationJob(workspaceId, campaign.id, run.id, job.id, (target) => {
      // Finalize marked ready above; this backfills poll-observed
      // ids/cost/capability unless the row settled elsewhere meanwhile.
      if (target.status === "cancelled" || target.status === "outcome_unknown") return;
      if (status.costUsd !== undefined) target.muxCostUsd = status.costUsd;
      if (status.capability) target.actualCapability = status.capability;
      if (target.muxJobId === undefined && status.jobId) target.muxJobId = status.jobId;
    });
    return true;
  }
  if (status.terminal) {
    await failNarrationJob(
      workspaceId,
      campaign.id,
      run.id,
      job.id,
      `Muxing ended (${safePhaseState(status.status || "without video")}) before delivery. The narration audio is kept and the original reel is intact.`
    );
    return true;
  }
  return false;
}

/**
 * Atomic ready finalization: receipt creation, receiptId linkage,
 * narrated URL, final cost/capability/dimensions, status ready, and
 * finishedAt are written in ONE locked write. A job never becomes ready
 * unless its private receipt exists and is linked. Idempotent via the
 * receiptId guard - safe to call from inline and poll paths alike.
 */
async function finalizeReadyNarration(
  workspaceId: string,
  campaignId: string,
  run: FilmRun,
  narrationJobId: string,
  result: {
    narratedUrl: string;
    capability?: string;
    costUsd?: number;
    actualWidth?: number;
    actualHeight?: number;
    durationSeconds?: number;
  }
): Promise<string | undefined> {
  let receiptId: string | undefined;
  await withCampaignLock(campaignId, () =>
    writeWorkspace(workspaceId, (d: Database) => {
      const c = d.campaigns.find((x) => x.id === campaignId);
      const owner = c?.filmRuns?.find((x) => x.id === run.id);
      const target = owner?.narrationJobs?.find((x) => x.id === narrationJobId);
      if (!c || !owner || !target || target.status === "cancelled" || target.status === "outcome_unknown") return;
      if (!target.receiptId) {
        const receipt = buildNarratedReceipt(
          c,
          owner,
          target,
          result.narratedUrl,
          result.capability,
          result.actualWidth,
          result.actualHeight,
          result.durationSeconds,
          result.costUsd
        );
        c.receipts.push(receipt);
        target.receiptId = receipt.id;
        d.events.push({
          id: newId("evt"),
          at: nowIso(),
          kind: "film-narration.ready",
          summary: `Narrated derivative ${receipt.id} ready for "${owner.filmTitle}". Original reel untouched.`,
          refs: [campaignId, run.id, target.id, receipt.id]
        });
      }
      target.narratedUrl = result.narratedUrl;
      // Phase costs stay with their phases (callers record them); the
      // combined figure lives on the receipt only, never written back.
      if (result.capability) target.actualCapability = result.capability;
      target.status = "ready";
      target.error = undefined;
      target.finishedAt = nowIso();
      receiptId = target.receiptId;
    })
  );
  return receiptId;
}

/**
 * Safe reconciliation for interrupted rows: a job holding a usable
 * narrated URL but no linked receipt gets exactly one private receipt
 * (receiptId guard - never duplicates). Status is never advanced here;
 * the pump keeps ready rows ready. Local-only, no provider contact.
 */
export async function reconcileNarratedReceipt(
  workspaceId: string,
  campaignId: string,
  filmRunId: string,
  narrationJobId: string
): Promise<string | undefined> {
  const db = await readWorkspace(workspaceId);
  const job = db.campaigns
    .find((c) => c.id === campaignId)
    ?.filmRuns?.find((x) => x.id === filmRunId)
    ?.narrationJobs?.find((x) => x.id === narrationJobId);
  if (!job || !job.narratedUrl || !isUsableOutputUrl(job.narratedUrl) || job.receiptId) return job?.receiptId;
  if (job.status === "cancelled" || job.status === "outcome_unknown") return undefined;
  let receiptId: string | undefined;
  await withCampaignLock(campaignId, () =>
    writeWorkspace(workspaceId, (d: Database) => {
      const target = d.campaigns
        .find((x) => x.id === campaignId)
        ?.filmRuns?.find((x) => x.id === filmRunId)
        ?.narrationJobs?.find((x) => x.id === narrationJobId);
      if (!target || target.receiptId || !target.narratedUrl || !isUsableOutputUrl(target.narratedUrl)) return;
      if (target.status === "cancelled" || target.status === "outcome_unknown") return;
      const c = d.campaigns.find((x) => x.id === campaignId);
      const owner = c?.filmRuns?.find((x) => x.id === filmRunId);
      if (!c || !owner) return;
      const receipt = buildNarratedReceipt(
        c,
        owner,
        target,
        target.narratedUrl,
        target.actualCapability,
        undefined,
        undefined,
        undefined,
        combineCost(target.ttsCostUsd, target.muxCostUsd)
      );
      c.receipts.push(receipt);
      target.receiptId = receipt.id;
      d.events.push({
        id: newId("evt"),
        at: nowIso(),
        kind: "film-narration.reconcile",
        summary: `Narrated receipt ${receipt.id} reconciled for interrupted job ${target.id}. Original reel untouched.`,
        refs: [campaignId, filmRunId, target.id, receipt.id]
      });
      receiptId = receipt.id;
    })
  );
  return receiptId;
}

/** Receipt cost: sum of reported phase costs; undefined until a phase reports. */
function combineCost(ttsCostUsd: number | undefined, muxCostUsd: number | undefined): number | undefined {
  const parts = [ttsCostUsd, muxCostUsd].filter((v): v is number => typeof v === "number");
  if (parts.length === 0) return undefined;
  return Math.round(parts.reduce((sum, v) => sum + v, 0) * 100) / 100;
}

/**
 * Advance one narration job: TTS dispatch → audio polls → mux dispatch
 * (known remaining cap only) → video polls → linked receipt. Bounded by
 * budgetMs; every step persists so later pumps resume from stored ids and
 * never re-dispatch. Stale claimed jobs are refused without dispatch.
 */
export async function pumpNarrationJob(
  workspaceId: string,
  campaignId: string,
  filmRunId: string,
  narrationJobId: string,
  opts: { budgetMs?: number } = {},
  client: FilmNarrationClient = defaultClient()
): Promise<NarrationPumpResult> {
  const lockKey = `filmnarrpump:${narrationJobId}`;
  if (pumpLocks.get(lockKey)) return { pumped: false, reason: "already-running" };
  pumpLocks.set(lockKey, true);
  try {
    const budgetMs = opts.budgetMs ?? 20_000;
    const deadline = Date.now() + budgetMs;
    let progressed = false;
    for (;;) {
      if (Date.now() >= deadline) return { pumped: progressed, reason: progressed ? undefined : "budget" };
      const db = await readWorkspace(workspaceId);
      const campaign = db.campaigns.find((c) => c.id === campaignId);
      const run = campaign ? findRun(campaign, filmRunId) : undefined;
      const job = campaign ? findNarrationJob(campaign, filmRunId, narrationJobId) : undefined;
      if (!campaign || !run || !job) return { pumped: progressed, reason: "not-found" };
      if (isTerminalNarrationStatus(job.status)) {
        // Self-healing for interrupted rows: a ready job holding a usable
        // narrated URL but no linked receipt gets exactly one (local-only,
        // idempotent - no provider contact).
        if (
          job.status === "ready" &&
          job.narratedUrl &&
          isUsableOutputUrl(job.narratedUrl) &&
          !job.receiptId
        ) {
          await reconcileNarratedReceipt(workspaceId, campaignId, filmRunId, narrationJobId);
          return { pumped: true, reason: "reconciled" };
        }
        return { pumped: progressed, reason: progressed ? undefined : "settled" };
      }
      // Interrupted-claim safety first: a stale claimed job may already
      // have been dispatched before a restart - never auto-resubmit.
      if (isNarrationStale(job)) return { pumped: progressed, reason: "stale-claim" };

      if (job.status === "queued") {
        const dispatched = await dispatchTts(workspaceId, campaignId, run, job, client);
        progressed = true;
        if (!dispatched.ok) return { pumped: true, reason: `tts-${dispatched.error}` };
      } else if (job.status === "generating_narration" || job.status === "waiting_for_narration") {
        if (job.narrationAudioUrl && isUsableOutputUrl(job.narrationAudioUrl)) {
          // Inline-audio rows never polled: normalize generating → waiting
          // (locked, provider-free) so the mux claim below sees the single
          // allowed pre-state. Polled rows already arrive as waiting.
          if (job.status === "generating_narration") {
            await writeNarrationJob(workspaceId, campaignId, run.id, job.id, (target) => {
              if (target.status === "generating_narration" && target.narrationAudioUrl) {
                target.status = "waiting_for_narration";
              }
            });
          }
          const muxed = await dispatchMux(workspaceId, campaignId, run, job, job.narrationAudioUrl, client);
          progressed = true;
          if (!muxed.ok) return { pumped: true, reason: `mux-${muxed.error}` };
        } else if (!job.ttsJobId) {
          return { pumped: progressed, reason: "no-tts-id" };
        } else {
          let status;
          try {
            status = await client.getMediaStatus(job.ttsJobId);
          } catch {
            return { pumped: progressed, reason: "poll-transient" };
          }
          if (await applyTtsPoll(workspaceId, campaignId, run, job, status)) progressed = true;
        }
      } else if (job.status === "muxing") {
        if (!job.muxJobId) return { pumped: progressed, reason: "no-mux-id" };
        let status;
        try {
          status = await client.getMediaStatus(job.muxJobId);
        } catch {
          return { pumped: progressed, reason: "poll-transient" };
        }
        if (await applyMuxPoll(workspaceId, campaign, run, job, status)) progressed = true;
      } else {
        return { pumped: progressed, reason: `state-${job.status}` };
      }
      if (Date.now() >= deadline) return { pumped: progressed };
      const fresh = (await readWorkspace(workspaceId)).campaigns.find((c) => c.id === campaignId);
      const freshJob = fresh ? findNarrationJob(fresh, filmRunId, narrationJobId) : undefined;
      if (!freshJob || isTerminalNarrationStatus(freshJob.status)) return { pumped: true };
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, Math.max(0, deadline - Date.now()))));
    }
  } finally {
    pumpLocks.delete(lockKey);
  }
}

/**
 * Explicit unknown-outcome recovery: preserve the stale claimed job as a
 * terminal outcome_unknown record (data kept, ids never reused), then mint
 * a FRESH narration job with fresh ids and both phase idempotency keys.
 * Only the new job is submitted - never a retry of the uncertain record.
 */
export async function recoverNarrationJob(
  workspaceId: string,
  campaignId: string,
  filmRunId: string,
  narrationJobId: string,
  nowMs: number = Date.now()
): Promise<NarrationRecoveryResult> {
  const db = await readWorkspace(workspaceId);
  const campaign = db.campaigns.find((c) => c.id === campaignId);
  const run = campaign ? findRun(campaign, filmRunId) : undefined;
  const job = campaign ? findNarrationJob(campaign, filmRunId, narrationJobId) : undefined;
  if (!campaign || !run || !job) return { ok: false, error: "Narration job not found.", conflict: false };
  const blocked = narrationRecoveryError(job, nowMs);
  if (blocked) return { ok: false, error: blocked, conflict: false };
  const now = nowIso();
  let written: FilmNarrationJob | undefined;
  await withCampaignLock(campaignId, () =>
    writeWorkspace(workspaceId, (d: Database) => {
      const owner = d.campaigns.find((x) => x.id === campaignId)?.filmRuns?.find((x) => x.id === filmRunId);
      const target = owner?.narrationJobs?.find((x) => x.id === narrationJobId);
      // Authoritative re-check: on any failure write nothing at all.
      if (!owner || !target || narrationRecoveryError(target, nowMs)) return;
      const fresh: FilmNarrationJob = {
        id: newId("filmnar"),
        campaignId,
        filmRunId,
        script: target.script,
        scriptHash: target.scriptHash,
        estimatedSeconds: target.estimatedSeconds,
        narrationCapUsd: target.narrationCapUsd,
        sourceReelUrl: target.sourceReelUrl,
        status: "queued",
        ttsIdempotencyKey: newId("tts"),
        muxIdempotencyKey: newId("mux"),
        attempt: 1,
        idempotencyKey: newId("filmnar"),
        createdAt: now,
        updatedAt: now
      };
      target.status = "outcome_unknown";
      target.outcomeUnknownAt = now;
      target.error = NARRATION_OUTCOME_UNKNOWN_COPY;
      target.finishedAt = now;
      owner.narrationJobs = [...(owner.narrationJobs ?? []), { ...fresh }];
      const c = d.campaigns.find((x) => x.id === campaignId);
      if (c) c.updatedAt = now;
      d.events.push({
        id: newId("evt"),
        at: now,
        kind: "film-narration.recover",
        summary: `Narration job ${target.id} preserved as outcome-unknown (no recorded result); fresh request ${fresh.id} queued. Original reel unchanged.`,
        refs: [campaignId, filmRunId, target.id, fresh.id]
      });
      written = { ...fresh };
    })
  );
  if (!written) return { ok: false, error: NARRATION_RECOVERY_CONFLICT_MESSAGE, conflict: true };
  return { ok: true, job: written, recoveredFrom: narrationJobId };
}

/** HTTP mapping for narration recovery outcomes (pure): conflicts answer 409. */
export function narrationRecoverHttpOutcome(result: NarrationRecoveryResult): {
  status: 200 | 400 | 409;
  body: Record<string, unknown>;
} {
  if (result.ok) {
    return { status: 200, body: { ok: true, narrationJobId: result.job.id, recoveredFrom: result.recoveredFrom } };
  }
  if (result.conflict) return { status: 409, body: { error: NARRATION_RECOVERY_CONFLICT_MESSAGE } };
  return { status: 400, body: { error: result.error } };
}

/** Read-only record lookup for the status route (never dispatches - GETs stay provider-free). */
export type NarrationJobView = Omit<FilmNarrationJob, "script">;

export function findNarrationJobView(
  campaign: Campaign,
  filmRunId: string,
  narrationJobId: string
): NarrationJobView | undefined {
  const job = findNarrationJob(campaign, filmRunId, narrationJobId);
  if (!job) return undefined;
  // Script text stays out of API views (hash + metadata travel instead).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { script, ...view } = job;
  return view;
}

/**
 * Cancel one narration job: best-effort provider cancel of tracked phase
 * ids only, then local terminal marking. The reel, receipts, captions,
 * and all other campaign state are never touched.
 */
export async function cancelNarrationJob(
  workspaceId: string,
  campaignId: string,
  filmRunId: string,
  narrationJobId: string,
  client: FilmNarrationClient = defaultClient()
): Promise<{ cancelled: boolean; providerConfirmed: boolean; note: string }> {
  const db = await readWorkspace(workspaceId);
  const campaign = db.campaigns.find((c) => c.id === campaignId);
  const job = campaign ? findNarrationJob(campaign, filmRunId, narrationJobId) : undefined;
  if (!job) return { cancelled: false, providerConfirmed: false, note: "Narration job not found." };
  if (job.status === "ready") {
    return { cancelled: false, providerConfirmed: false, note: "Narrated output already delivered - nothing to cancel." };
  }
  if (job.status === "failed" || job.status === "cancelled" || job.status === "outcome_unknown") {
    return { cancelled: false, providerConfirmed: job.providerCancelConfirmed ?? false, note: `Narration job already ${job.status}.` };
  }
  let providerConfirmed = false;
  const notes: string[] = [];
  let tracked = false;
  for (const trackedId of [job.ttsJobId, job.muxJobId]) {
    if (!trackedId) continue;
    tracked = true;
    try {
      const result = await client.cancelProviderJob(trackedId);
      providerConfirmed = providerConfirmed || result.cancelled;
      notes.push(result.note);
    } catch (e) {
      logNarration("cancel", e);
      notes.push("A provider cancel call failed - verify at the provider.");
    }
  }
  const providerNote = tracked ? notes.join(" ") : "No provider job was tracked - nothing was submitted.";
  await writeNarrationJob(workspaceId, campaignId, filmRunId, narrationJobId, (target) => {
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
      ? "Narration job cancelled; provider confirmed. The original reel is untouched."
      : `Narration job cancelled locally. ${providerNote} The original reel is untouched.`
  };
}
