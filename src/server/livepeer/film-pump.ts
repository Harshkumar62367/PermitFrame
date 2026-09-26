import type { Campaign, Database } from "../types";
import { newId, nowIso, sha256 } from "../store";
import { throwIfArchived } from "../campaign-lifecycle";
import { readWorkspace, writeWorkspace } from "./run-store";
import { withCampaignLock } from "./mutex";
import { LivepeerMcpClient, livepeerConfig, type AssembleResult, type AsyncSubmitResult, type MediaStatusResult } from "./mcp-client";
import { FILM_SUPPORTED_ASPECTS, validateFilmPlan } from "./film-plan";
import {
  buildCreativeSubmitArgs,
  filmSceneFingerprint,
  type CreativeStatusParsed,
  type CreativeSubmitArgs,
  type CreativeSubmitParsed
} from "./film-job";
import {
  checkFilmCap,
  filmProviderWatchdogSeconds,
  isFilmWatchdogExpired,
  nextFilmAction,
  type FilmRun,
  type FilmRunStatus
} from "./film-run";
import { classifyProviderFailure } from "./run-retry";
import { isUsableOutputUrl } from "./plan-dag";
import { redactSecrets } from "../dkg/edge-node-adapter";
import { resolveSourceMediaUrl } from "../cloudinary";

/**
 * Campaign Film execution: a separate, durable path from the short-clip
 * runner. One FilmRun owns exactly one provider creative job; the provider
 * id is persisted before any poll/confirm, and a durable submit claim is
 * persisted before the external call, so retry and resume never submit a
 * second paid job (the observed submit schema carries no idempotency key -
 * stability comes from that claim/id plus the stable per-run session tag).
 * Short-clip state (jobs, receipts, runs, preflight, plan)
 * is never read for decisions and never written. No DKG, no audio.
 */

/** Minimal provider surface the film pump needs (LivepeerMcpClient satisfies it structurally). */
export interface FilmMcpClient {
  submitCreativeJob(args: CreativeSubmitArgs): Promise<CreativeSubmitParsed>;
  confirmCreativeJob(providerJobId: string): Promise<CreativeSubmitParsed>;
  getCreativeJob(jobId: string): Promise<CreativeStatusParsed>;
  cancelCreativeJob(jobId: string, transportTimeoutMs?: number): Promise<{ cancelled: boolean; note: string }>;
  /** Present on the production client. Optional keeps legacy creative-job tests valid. */
  submitMedia?: (input: {
    capability: string; kind?: "image-to-video"; prompt?: string; sourceUrl?: string;
    inputs?: Record<string, unknown>; maxCostUsd?: number; sessionId?: string; idempotencyKey?: string;
  }) => Promise<AsyncSubmitResult>;
  getMediaStatus?: (jobId: string) => Promise<MediaStatusResult>;
  assembleClips?: (input: { clips: Array<{ url: string; title?: string }>; title: string; sessionId: string }) => Promise<AssembleResult>;
  cancelProviderJob?: (jobId: string, transportTimeoutMs?: number) => Promise<{ cancelled: boolean; note: string }>;
}

export interface FilmSubmitResult {
  run?: FilmRun;
  created: boolean;
  error?: string;
}

export interface FilmPumpResult {
  pumped: boolean;
  reason?: string;
}

export interface FilmPumpOptions {
  runId?: string;
  budgetMs?: number;
  /** Status GETs are poll-only: never submit or confirm new provider work. */
  allowSubmit?: boolean;
  allowConfirm?: boolean;
}

const pumpLocks = new Map<string, boolean>();

function defaultClient(): FilmMcpClient {
  return new LivepeerMcpClient(livepeerConfig());
}

function logFilm(scope: string, raw: unknown): void {
  const message = raw instanceof Error ? raw.message : String(raw ?? "");
  console.error(`[film-run:${scope}]`, redactSecrets(message).slice(0, 500));
}

function findFilmRun(campaign: Campaign, filmRunId: string): FilmRun | undefined {
  return campaign.filmRuns?.find((r) => r.id === filmRunId);
}

function activeFilmRun(campaign: Campaign): FilmRun | undefined {
  return [...(campaign.filmRuns ?? [])]
    .reverse()
    .find((r) => r.status !== "ready" && r.status !== "failed" && r.status !== "cancelled");
}

async function enforceFilmWatchdog(
  workspaceId: string,
  campaignId: string,
  run: FilmRun,
  client: FilmMcpClient,
  now = Date.now()
): Promise<boolean> {
  if (!isFilmWatchdogExpired(run, now)) return false;
  let providerJobId: string | undefined;
  let shouldCancel = false;
  await withCampaignLock(campaignId, () =>
    writeWorkspace(workspaceId, (d: Database) => {
      const current = d.campaigns.find((c) => c.id === campaignId)?.filmRuns?.find((r) => r.id === run.id);
      if (!current || !isFilmWatchdogExpired(current, now)) return;
      providerJobId = current.providerJobId;
      current.lastProviderJobId = current.lastProviderJobId ?? current.providerJobId;
      if (!current.watchdogCancelAttemptedAt) {
        current.watchdogCancelAttemptedAt = nowIso();
        shouldCancel = true;
      }
    })
  );
  let confirmed = false;
  if (providerJobId && shouldCancel) {
    try {
      confirmed = (await client.cancelCreativeJob(providerJobId, 5_000)).cancelled;
    } catch (e) {
      logFilm("watchdog", e);
    }
  }
  await writeFilmRun(workspaceId, campaignId, run.id, (current) => {
    if (current.status === "ready" || current.status === "cancelled" || current.status === "failed") return;
    current.status = "failed";
    current.providerFailureKind = "provider_timeout";
    current.providerCancelConfirmed = confirmed;
    current.providerJobId = undefined;
    current.submissionClaimedAt = undefined;
    current.dispatchStartedAt = undefined;
    current.providerBudgetSeconds = undefined;
    current.dispatchBudgetSeconds = undefined;
    current.dispatchDeadlineAt = undefined;
    current.providerStatus = "timeout";
    current.error = providerJobId
      ? "The tracked film job did not deliver a reel within its film processing window. We stopped following it; check the provider before resuming this run for a fresh attempt."
      : "The provider did not acknowledge this film submission within its film processing window. No provider job is tracked; resume this run only if you want a fresh attempt.";
    current.finishedAt = nowIso();
  });
  return true;
}

/**
 * Submit a film run: validate the persisted plan, create one durable run,
 * return immediately. Never dispatches - the pump does that. Repeats with
 * the same idempotency key replay the existing run; a second submit while
 * one is active returns the active run instead of a duplicate paid job.
 */
export async function submitFilmRun(input: {
  workspaceId: string;
  campaignId: string;
  idempotencyKey?: string;
}): Promise<FilmSubmitResult> {
  // Check and persist under the same campaign lock. Previously two requests
  // could both observe "no active run" before either write completed.
  return withCampaignLock(input.campaignId, () => submitFilmRunLocked(input));
}

async function submitFilmRunLocked(input: {
  workspaceId: string;
  campaignId: string;
  idempotencyKey?: string;
}): Promise<FilmSubmitResult> {
  const db = await readWorkspace(input.workspaceId);
  const campaign = db.campaigns.find((c) => c.id === input.campaignId);
  if (!campaign) return { created: false, error: "Campaign not found" };
  try {
    throwIfArchived(campaign, "film-submitted");
  } catch (e) {
    return { created: false, error: e instanceof Error ? e.message : "Archived campaigns are read-only." };
  }
  if (campaign.preflight?.decision !== "allow") {
    return { created: false, error: "Resolve the rights block before submitting a film - blocked campaigns never reach generation." };
  }
  const key = input.idempotencyKey?.trim() || undefined;
  if (key) {
    const replay = campaign.filmRuns?.find((r) => r.idempotencyKey === key);
    if (replay) return { run: replay, created: false };
  }
  const active = activeFilmRun(campaign);
  if (active) return { run: active, created: false };
  if (!campaign.request.filmPlan) {
    return { created: false, error: "Save a film plan first - there is no confirmed plan to submit." };
  }
  const validated = validateFilmPlan(campaign.request.filmPlan);
  if (!validated.ok) {
    return { created: false, error: `The saved film plan is no longer valid: ${validated.error}` };
  }
  const plan = validated.filmPlan;
  const sourceMedia = db.sourceMedia.find((media) => media.id === campaign.sourceMediaId);
  if (!sourceMedia) {
    return { created: false, error: "The approved source media is missing, so this film cannot be dispatched." };
  }
  // Aspect honesty, enforced again at the dispatch boundary: validation
  // already rejects unsupported aspects, but submission must never depend
  // on a single layer - an unsupported aspect fails here with no provider
  // request made.
  if (!FILM_SUPPORTED_ASPECTS.includes(plan.aspectRatio) || plan.scenes.some((s) => !FILM_SUPPORTED_ASPECTS.includes(s.format))) {
    return {
      created: false,
      error: "Campaign Film cannot submit with this aspect - the provider film surface supports 9:16, 1:1, or 16:9 only. No provider request was made; use 4:3 for portrait stills instead."
    };
  }
  const now = nowIso();
  const run: FilmRun = {
    id: newId("filmrun"),
    campaignId: input.campaignId,
    filmTitle: plan.title,
    targetDurationSeconds: plan.targetDurationSeconds,
    aspectRatio: plan.aspectRatio,
    budgetCapUsd: plan.budgetCapUsd,
    sceneFingerprint: filmSceneFingerprint(plan.scenes, sha256),
    plannedScenes: plan.scenes.map((s) => ({ ...s })),
    sourceMediaId: sourceMedia.id,
    brand: campaign.brand,
    productName: campaign.productName,
    creativeBrief: campaign.request.creativeBrief,
    providerSessionId: `permitframe_${newId("filmrun").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60)}`,
    status: "confirmed",
    requestedCapability: "kling-v3-turbo-i2v (source-bound scenes + assembly)",
    sceneOutputs: [],
    preservation: {
      requested: "source-guided-generation",
      evidenceLevel: "none",
      note: "Each scene receives the approved source media directly as image-to-video input. Outputs still require review; no identity-preservation claim is made."
    },
    ...(key ? { idempotencyKey: key } : {}),
    createdAt: now,
    updatedAt: now
  };
  await writeWorkspace(input.workspaceId, (d: Database) => {
      const c = d.campaigns.find((x) => x.id === input.campaignId);
      if (!c) return;
      c.filmRuns = [...(c.filmRuns ?? []), run];
      c.updatedAt = nowIso();
      d.events.push({
        id: newId("evt"),
        at: nowIso(),
        kind: "film-run.submit",
        summary: `Film run ${run.id} confirmed for "${c.title}" (${plan.targetDurationSeconds}s, ${plan.scenes.length} scenes, $${plan.budgetCapUsd.toFixed(2)} maximum). Provider job not submitted yet.`,
        refs: [input.campaignId, run.id]
      });
    }, { mirror: false });
  return { run, created: true };
}

async function writeFilmRun(
  workspaceId: string,
  campaignId: string,
  filmRunId: string,
  mutate: (run: FilmRun) => void
): Promise<FilmRun | undefined> {
  let out: FilmRun | undefined;
  await withCampaignLock(campaignId, () =>
    writeWorkspace(workspaceId, (d: Database) => {
      const run = d.campaigns.find((x) => x.id === campaignId)?.filmRuns?.find((x) => x.id === filmRunId);
      if (!run) return;
      mutate(run);
      run.updatedAt = nowIso();
      out = { ...run, sceneOutputs: run.sceneOutputs.map((s) => ({ ...s })), plannedScenes: run.plannedScenes.map((s) => ({ ...s })) };
    }, { mirror: false })
  );
  return out;
}

async function failFilmRun(
  workspaceId: string,
  campaignId: string,
  filmRunId: string,
  error: string
): Promise<void> {
  await writeFilmRun(workspaceId, campaignId, filmRunId, (run) => {
    if (run.status === "ready" || run.status === "cancelled") return;
    run.status = "failed";
    run.error = error;
    run.lastProviderJobId = run.lastProviderJobId ?? run.providerJobId;
    run.providerJobId = undefined;
    run.submissionClaimedAt = undefined;
    run.dispatchStartedAt = undefined;
    run.providerBudgetSeconds = undefined;
    run.dispatchBudgetSeconds = undefined;
    run.dispatchDeadlineAt = undefined;
    run.finishedAt = nowIso();
  });
}

function submitArgsFor(run: FilmRun, sourceUrl: string): CreativeSubmitArgs {
  return buildCreativeSubmitArgs(
    {
      title: run.filmTitle,
      targetDurationSeconds: run.targetDurationSeconds,
      aspectRatio: run.aspectRatio,
      budgetCapUsd: run.budgetCapUsd,
      scenes: run.plannedScenes
    },
    run.providerSessionId,
    sourceUrl
  );
}

/** Resolve the approved source immediately before dispatch. Private uploads
 * receive a fresh time-limited URL, which never appears in a FilmRun. */
async function filmSourceUrl(workspaceId: string, campaignId: string, run: FilmRun): Promise<string> {
  const db = await readWorkspace(workspaceId);
  const campaign = db.campaigns.find((item) => item.id === campaignId);
  const sourceId = run.sourceMediaId ?? campaign?.sourceMediaId;
  const source = db.sourceMedia.find((media) => media.id === sourceId && media.id === campaign?.sourceMediaId);
  if (!source) throw new Error("The approved source media is no longer available for this film run.");
  const url = resolveSourceMediaUrl(source);
  if (!isUsableOutputUrl(url)) throw new Error("The approved source media did not resolve to a safe HTTPS URL.");
  return url;
}

/** Apply one submit/confirm response: refusal, staged gate, or tracked id. Returns true on state change. */
async function applySubmitResponse(
  workspaceId: string,
  campaignId: string,
  run: FilmRun,
  parsed: CreativeSubmitParsed,
  phase: "submit" | "confirm"
): Promise<boolean> {
  if (parsed.budgetExceeded) {
    const estimate = parsed.budgetExceeded.estimateUsd !== undefined ? `$${parsed.budgetExceeded.estimateUsd.toFixed(2)}` : "over budget";
    await failFilmRun(
      workspaceId,
      campaignId,
      run.id,
      `Provider refused the film (${estimate} exceeds the confirmed $${run.budgetCapUsd.toFixed(2)} maximum) - nothing was staged or dispatched.`
    );
    return true;
  }
  const capRefusal = checkFilmCap(run.budgetCapUsd, parsed.estimateUsd);
  if (capRefusal) {
    await failFilmRun(workspaceId, campaignId, run.id, capRefusal);
    return true;
  }
  if (!parsed.providerJobId) {
    await failFilmRun(
      workspaceId,
      campaignId,
      run.id,
      `Film ${phase} returned no provider job id - nothing is tracked and nothing was dispatched.`
    );
    return true;
  }
  await writeFilmRun(workspaceId, campaignId, run.id, (r) => {
    // A late provider response must never revive a run that the user
    // cancelled or that the watchdog already settled.
    if (r.status === "ready" || r.status === "cancelled" || r.status === "failed") return;
    r.providerJobId = parsed.providerJobId as string;
    r.lastProviderJobId = parsed.providerJobId as string;
    r.providerStatus = parsed.awaitingConfirmation ? "awaiting_confirmation" : "submitted";
    r.status = "submitting";
    r.dispatchStartedAt = r.dispatchStartedAt ?? nowIso();
    if (parsed.budgetSeconds !== undefined) r.providerBudgetSeconds = parsed.budgetSeconds;
    r.submissionClaimedAt = undefined;
    r.dispatchBudgetSeconds = filmProviderWatchdogSeconds(parsed.budgetSeconds);
    r.dispatchDeadlineAt = new Date(Date.parse(r.dispatchStartedAt) + r.dispatchBudgetSeconds * 1000).toISOString();
    if (parsed.estimateUsd !== undefined) r.estimateUsd = parsed.estimateUsd;
    if (parsed.budgetUsd !== undefined && parsed.budgetUsd > 0) r.budgetCapUsd = Math.min(r.budgetCapUsd, parsed.budgetUsd);
    r.error = undefined;
  });
  return true;
}

/** Apply one status poll: gate, progress, ready (reel HTTPS only), or honest failure. */
async function applyStatusResponse(
  workspaceId: string,
  campaignId: string,
  run: FilmRun,
  parsed: CreativeStatusParsed
): Promise<boolean> {
  const reelUsable = parsed.reelUrl !== undefined && isUsableOutputUrl(parsed.reelUrl);
  const gate = parsed.awaitingConfirmation;
  const nextStatus: FilmRunStatus = parsed.failed
    ? "failed"
    : parsed.terminal && reelUsable
      ? "ready"
      : parsed.terminal
        ? "failed"
        : /assembl|stitch|finish|deliver/.test(parsed.statusText)
          ? "assembling_reel"
          : "generating_scenes";
  const error =
    nextStatus === "failed"
      ? parsed.failed
        ? `Film job ended (${parsed.statusText || "failed"}) before delivery.`
        : "Film job completed without a final reel URL - nothing deliverable was returned."
      : undefined;
  await writeFilmRun(workspaceId, campaignId, run.id, (r) => {
    if (r.status === "ready" || r.status === "cancelled") return;
    if (parsed.providerJobId && !r.providerJobId) r.providerJobId = parsed.providerJobId;
    if (parsed.viewerUrl) r.providerViewerUrl = parsed.viewerUrl;
    r.providerStatus = gate ? "awaiting_confirmation" : parsed.statusText || r.providerStatus;
    r.status = gate ? "submitting" : nextStatus;
    r.sceneOutputs = parsed.sceneOutputs.map((s) => ({ ...s }));
    if (parsed.costUsd !== undefined) r.costUsd = parsed.costUsd;
    if (parsed.estimateUsd !== undefined) r.estimateUsd = parsed.estimateUsd;
    if (parsed.capability) r.actualCapability = parsed.capability;
    if (parsed.budgetSeconds !== undefined) {
      r.providerBudgetSeconds = parsed.budgetSeconds;
      r.dispatchBudgetSeconds = filmProviderWatchdogSeconds(parsed.budgetSeconds);
      const anchor = Date.parse(r.dispatchStartedAt ?? "");
      if (Number.isFinite(anchor)) r.dispatchDeadlineAt = new Date(anchor + r.dispatchBudgetSeconds * 1000).toISOString();
    }
    if (nextStatus === "ready" && parsed.reelUrl) r.reelUrl = parsed.reelUrl;
    if (error) {
      r.error = error;
      r.providerFailureKind = classifyProviderFailure(parsed.statusText, typeof parsed.raw.error === "string" ? parsed.raw.error : undefined) ?? "failed_without_output";
      r.lastProviderJobId = r.lastProviderJobId ?? r.providerJobId;
      r.providerJobId = undefined;
      r.submissionClaimedAt = undefined;
      r.dispatchStartedAt = undefined;
      r.providerBudgetSeconds = undefined;
      r.dispatchBudgetSeconds = undefined;
      r.dispatchDeadlineAt = undefined;
      r.finishedAt = nowIso();
    } else if (nextStatus === "ready") {
      r.error = undefined;
      r.submissionClaimedAt = undefined;
      r.dispatchStartedAt = undefined;
      r.providerBudgetSeconds = undefined;
      r.dispatchBudgetSeconds = undefined;
      r.dispatchDeadlineAt = undefined;
      r.finishedAt = nowIso();
    }
  });
  return true;
}

/** Atomically reserve the one external submit call for this durable run. */
async function claimFilmSubmission(
  workspaceId: string,
  campaignId: string,
  filmRunId: string
): Promise<FilmRun | undefined> {
  let claimed: FilmRun | undefined;
  await withCampaignLock(campaignId, () =>
    writeWorkspace(workspaceId, (d: Database) => {
      const current = d.campaigns.find((c) => c.id === campaignId)?.filmRuns?.find((r) => r.id === filmRunId);
      if (!current || current.providerJobId || current.submissionClaimedAt || current.status === "ready" || current.status === "failed" || current.status === "cancelled") return;
      const startedAt = nowIso();
      current.status = "submitting";
      current.submissionClaimedAt = startedAt;
      current.dispatchStartedAt = startedAt;
      current.providerBudgetSeconds = undefined;
      current.dispatchBudgetSeconds = filmProviderWatchdogSeconds();
      current.dispatchDeadlineAt = new Date(Date.parse(startedAt) + current.dispatchBudgetSeconds * 1000).toISOString();
      current.updatedAt = nowIso();
      claimed = {
        ...current,
        sceneOutputs: current.sceneOutputs.map((s) => ({ ...s })),
        plannedScenes: current.plannedScenes.map((s) => ({ ...s }))
      };
    })
  );
  return claimed;
}

function supportsSourceBoundFilm(client: FilmMcpClient): client is FilmMcpClient & Required<Pick<FilmMcpClient, "submitMedia" | "getMediaStatus" | "assembleClips">> {
  return typeof client.submitMedia === "function" && typeof client.getMediaStatus === "function" && typeof client.assembleClips === "function";
}

function sourceBoundPrompt(run: FilmRun, scene: FilmRun["plannedScenes"][number]): string {
  const product = [run.brand, run.productName].filter(Boolean).join(" ") || run.filmTitle;
  const brief = run.creativeBrief ? ` Campaign brief: ${run.creativeBrief}` : "";
  return [
    `Animate the exact approved source image of ${product}.`,
    `Scene: ${scene.title}. ${scene.visualDirection}`,
    "Keep the same product, colorway, shape, logo, material, and product category from the source image.",
    "Do not replace it with a person, different product, packaging, or an unrelated scene. No invented text or claims.",
    "Use subtle product-focused camera movement appropriate for a short commercial clip.",
    brief
  ].join(" ");
}

async function initialiseSourceBoundScenes(workspaceId: string, campaignId: string, runId: string): Promise<FilmRun | undefined> {
  return writeFilmRun(workspaceId, campaignId, runId, (run) => {
    if (run.status === "failed" || run.status === "cancelled" || run.status === "ready") return;
    const isLegacyCreativeRun = run.requestedCapability.startsWith("submit_creative_job");
    // A failed legacy storyboard job may contain unrelated provider clips.
    // They were not produced with source_url and cannot be safely mixed into
    // the new source-bound reel. Clear them exactly once on migration.
    if (isLegacyCreativeRun) {
      run.sceneOutputs = [];
      run.providerJobId = undefined;
      run.lastProviderJobId = undefined;
      run.assemblyJobId = undefined;
      run.assemblyClaimedAt = undefined;
      run.reelUrl = undefined;
      run.actualCapability = undefined;
    }
    if (run.sceneOutputs.length === 0) {
      run.sceneOutputs = run.plannedScenes.map((scene, index) => ({ index, title: scene.title, status: "queued" }));
    }
    run.requestedCapability = "kling-v3-turbo-i2v (source-bound scenes + assembly)";
    // Retry route moves a failed run back to confirmed. Keep successful
    // clips and requeue only failed rows before starting another pump.
    if (run.status === "confirmed" && run.sceneOutputs.some((scene) => scene.status === "failed")) {
      run.sceneOutputs = run.sceneOutputs.map((scene) => scene.status === "failed"
        ? {
            index: scene.index,
            title: scene.title,
            status: "queued",
            attempt: (scene.attempt ?? 0) + 1,
            lastProviderJobId: scene.lastProviderJobId ?? scene.providerJobId
          }
        : scene);
    }
    run.status = run.status === "confirmed" || run.status === "submitting" ? "generating_scenes" : run.status;
    run.providerStatus = "source-bound scene queue";
    run.error = undefined;
  });
}

async function pumpSourceBoundFilmRun(
  workspaceId: string,
  campaignId: string,
  filmRunId: string,
  opts: FilmPumpOptions,
  client: FilmMcpClient & Required<Pick<FilmMcpClient, "submitMedia" | "getMediaStatus" | "assembleClips">>
): Promise<FilmPumpResult> {
  const deadline = Date.now() + (opts.budgetMs ?? 20_000);
  let progressed = false;
  const initial = (await readWorkspace(workspaceId)).campaigns
    .find((item) => item.id === campaignId)?.filmRuns?.find((item) => item.id === filmRunId);
  if (!initial) return { pumped: false, reason: "not-found" };
  if (initial.status === "failed" || initial.status === "cancelled" || initial.status === "ready") {
    return { pumped: false, reason: "settled" };
  }
  let run = await initialiseSourceBoundScenes(workspaceId, campaignId, filmRunId);
  if (!run || run.status === "failed" || run.status === "cancelled" || run.status === "ready") return { pumped: false, reason: "settled" };
  if (!run) return { pumped: false, reason: "not-found" };

  while (Date.now() < deadline) {
    const db = await readWorkspace(workspaceId);
    const campaign = db.campaigns.find((item) => item.id === campaignId);
    run = campaign ? findFilmRun(campaign, filmRunId) : undefined;
    if (!run || run.status === "failed" || run.status === "cancelled" || run.status === "ready") return { pumped: progressed, reason: "settled" };

    // First poll every in-flight scene. A terminal response without a video
    // is a scene failure, never silently treated as a reel or still image.
    const active = run.sceneOutputs.filter((scene) => scene.providerJobId && !["ready", "failed"].includes(scene.status ?? ""));
    for (const scene of active) {
      try {
        const status = await client.getMediaStatus(scene.providerJobId as string);
        await writeFilmRun(workspaceId, campaignId, filmRunId, (current) => {
          const target = current.sceneOutputs.find((row) => row.index === scene.index);
          if (!target || target.providerJobId !== scene.providerJobId) return;
          target.status = status.outputUrl && isUsableOutputUrl(status.outputUrl) ? "ready" : status.terminal ? "failed" : status.status;
          if (status.outputUrl && isUsableOutputUrl(status.outputUrl)) target.url = status.outputUrl;
          if (status.capability) current.actualCapability = status.capability;
          if (status.costUsd !== undefined) target.costUsd = status.costUsd;
          if (status.terminal) {
            target.finishedAt = nowIso();
            target.lastProviderJobId = target.providerJobId;
            target.providerJobId = undefined;
            if (!target.url) target.error = status.error || "Provider completed this scene without a usable video output.";
          }
        });
        progressed = true;
      } catch (error) {
        logFilm("scene-poll", error);
      }
    }

    const currentDb = await readWorkspace(workspaceId);
    const current = currentDb.campaigns.find((item) => item.id === campaignId)?.filmRuns?.find((item) => item.id === filmRunId);
    if (!current || current.status === "failed" || current.status === "cancelled" || current.status === "ready") return { pumped: progressed, reason: "settled" };
    if (current.sceneOutputs.some((scene) => scene.status === "failed")) {
      await writeFilmRun(workspaceId, campaignId, filmRunId, (saved) => {
        saved.status = "failed";
        saved.error = "One or more source-bound scene clips failed. Completed clips were kept; resume retries only the failed scenes.";
        saved.finishedAt = nowIso();
      });
      return { pumped: true, reason: "scene-failed" };
    }

    const inFlight = current.sceneOutputs.filter((scene) => scene.providerJobId).length;
    const queued = current.sceneOutputs.filter((scene) => scene.status === "queued");
    if (queued.length > 0 && inFlight < 2) {
      if (opts.allowSubmit === false) return { pumped: progressed, reason: "read-only" };
      const sourceUrl = await filmSourceUrl(workspaceId, campaignId, current);
      const slots = queued.slice(0, 2 - inFlight);
      for (const queuedScene of slots) {
        const claimed = await writeFilmRun(workspaceId, campaignId, filmRunId, (saved) => {
          const target = saved.sceneOutputs.find((row) => row.index === queuedScene.index);
          if (!target || target.status !== "queued") return;
          target.status = "submitting";
          target.startedAt = nowIso();
        });
        const scene = claimed?.sceneOutputs.find((row) => row.index === queuedScene.index);
        if (!scene || scene.status !== "submitting") continue;
        try {
          const planned = claimed?.plannedScenes[scene.index];
          if (!planned) throw new Error("Confirmed film scene is missing.");
          const result = await client.submitMedia({
            capability: "kling-v3-turbo-i2v",
            kind: "image-to-video",
            prompt: sourceBoundPrompt(claimed as FilmRun, planned),
            sourceUrl,
            inputs: { aspect_ratio: claimed?.aspectRatio, duration: planned.durationSeconds },
            maxCostUsd: Math.max(0.01, (claimed?.budgetCapUsd ?? 0) / Math.max(1, claimed?.plannedScenes.length ?? 1)),
            sessionId: claimed?.providerSessionId,
            idempotencyKey: `pf_${filmRunId}_scene_${scene.index}_attempt_${scene.attempt ?? 0}`
          });
          await writeFilmRun(workspaceId, campaignId, filmRunId, (saved) => {
            const target = saved.sceneOutputs.find((row) => row.index === scene.index);
            if (!target || target.status !== "submitting") return;
            target.status = result.outputUrl && isUsableOutputUrl(result.outputUrl) ? "ready" : result.status || "submitted";
            if (result.outputUrl && isUsableOutputUrl(result.outputUrl)) { target.url = result.outputUrl; target.finishedAt = nowIso(); }
            if (result.jobId) target.providerJobId = result.jobId;
            if (result.costUsd !== undefined) target.costUsd = result.costUsd;
            if (result.capability) saved.actualCapability = result.capability;
          });
          progressed = true;
        } catch (error) {
          logFilm("scene-submit", error);
          const safeReason = redactSecrets(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);
          await writeFilmRun(workspaceId, campaignId, filmRunId, (saved) => {
            const target = saved.sceneOutputs.find((row) => row.index === scene.index);
            if (!target) return;
            target.status = "failed";
            target.error = safeReason
              ? `Provider did not accept this source-bound scene job: ${safeReason}`
              : "Provider did not accept this source-bound scene job.";
            target.finishedAt = nowIso();
          });
          await writeFilmRun(workspaceId, campaignId, filmRunId, (saved) => {
            if (saved.status === "cancelled" || saved.status === "ready") return;
            saved.status = "failed";
            saved.error = "One or more source-bound scene clips failed. Completed clips were kept; resume retries only the failed scenes.";
            saved.finishedAt = nowIso();
          });
          return { pumped: true, reason: "scene-submit-failed" };
        }
      }
      continue;
    }

    const ready = current.sceneOutputs.filter((scene) => scene.status === "ready" && scene.url && isUsableOutputUrl(scene.url));
    if (ready.length !== current.plannedScenes.length) return { pumped: progressed, reason: "scene-progress" };
    if (opts.allowSubmit === false) return { pumped: progressed, reason: "read-only" };

    if (!current.assemblyJobId && !current.assemblyClaimedAt) {
      const assemblyClaimed = await writeFilmRun(workspaceId, campaignId, filmRunId, (saved) => {
        if (saved.assemblyJobId || saved.assemblyClaimedAt) return;
        saved.status = "assembling_reel";
        saved.assemblyClaimedAt = nowIso();
        saved.providerStatus = "assembling verified scene clips";
      });
      if (!assemblyClaimed?.assemblyClaimedAt) continue;
      try {
        const result = await client.assembleClips({
          clips: assemblyClaimed.sceneOutputs.sort((a, b) => a.index - b.index).map((scene) => ({ url: scene.url as string, title: scene.title })),
          title: assemblyClaimed.filmTitle,
          sessionId: assemblyClaimed.providerSessionId
        });
        await writeFilmRun(workspaceId, campaignId, filmRunId, (saved) => {
          saved.assemblyClaimedAt = undefined;
          saved.assemblyJobId = result.jobId;
          saved.providerStatus = result.status;
          if (result.costUsd !== undefined) saved.costUsd = (saved.costUsd ?? 0) + result.costUsd;
          if (result.outputUrl && isUsableOutputUrl(result.outputUrl)) {
            saved.reelUrl = result.outputUrl;
            saved.status = "ready";
            saved.finishedAt = nowIso();
          }
        });
        progressed = true;
        continue;
      } catch (error) {
        logFilm("assemble", error);
        await failFilmRun(workspaceId, campaignId, filmRunId, "All scene clips completed, but final assembly did not return a tracked reel job. Scene clips were kept; resume to retry assembly.");
        return { pumped: true, reason: "assembly-failed" };
      }
    }

    if (current.assemblyJobId) {
      try {
        const status = await client.getMediaStatus(current.assemblyJobId);
        await writeFilmRun(workspaceId, campaignId, filmRunId, (saved) => {
          saved.providerStatus = status.status;
          if (status.outputUrl && isUsableOutputUrl(status.outputUrl)) {
            saved.reelUrl = status.outputUrl;
            saved.status = "ready";
            saved.finishedAt = nowIso();
          } else if (status.terminal) {
            saved.status = "failed";
            saved.error = status.error || "Final assembly completed without a usable reel URL. Scene clips were kept.";
            saved.finishedAt = nowIso();
          }
        });
        return { pumped: true, reason: "assembly-progress" };
      } catch (error) {
        logFilm("assembly-poll", error);
        return { pumped: progressed, reason: "assembly-poll-transient" };
      }
    }
  }
  return { pumped: progressed, reason: "budget" };
}

/**
 * Advance one film run: durably claim + submit, confirm a staged gate inside
 * the cap, or poll. Bounded by budgetMs; every step persists so any later
 * pump - or a process restart - resumes from the stored claim/provider id
 * and never re-submits. Concurrent pumps for one run collapse into one.
 */
export async function pumpFilmRun(
  workspaceId: string,
  campaignId: string,
  filmRunId: string,
  opts: FilmPumpOptions = {},
  client: FilmMcpClient = defaultClient()
): Promise<FilmPumpResult> {
  const lockKey = `filmpump:${filmRunId}`;
  if (pumpLocks.get(lockKey)) return { pumped: false, reason: "already-running" };
  pumpLocks.set(lockKey, true);
  try {
    // Production Film deliberately uses the same durable, source-bound
    // image-to-video protocol as Short Clip. The older creative-job path is
    // retained only for legacy test doubles that do not implement it.
    if (supportsSourceBoundFilm(client)) {
      return await pumpSourceBoundFilmRun(workspaceId, campaignId, filmRunId, opts, client);
    }
    const budgetMs = opts.budgetMs ?? 20_000;
    const deadline = Date.now() + budgetMs;
    let progressed = false;
    for (;;) {
      if (Date.now() >= deadline) return { pumped: progressed, reason: progressed ? undefined : "budget" };
      const db = await readWorkspace(workspaceId);
      const campaign = db.campaigns.find((c) => c.id === campaignId);
      const run = campaign ? findFilmRun(campaign, filmRunId) : undefined;
      if (!run) return { pumped: progressed, reason: "not-found" };
      if (run.status === "ready" || run.status === "failed" || run.status === "cancelled") {
        return { pumped: progressed, reason: progressed ? undefined : "settled" };
      }
      if (await enforceFilmWatchdog(workspaceId, campaignId, run, client)) {
        return { pumped: true, reason: "watchdog" };
      }
      const action = nextFilmAction(run);
      if (action === "none") return { pumped: progressed, reason: "settled" };

      if (action === "submit") {
        if (opts.allowSubmit === false) return { pumped: progressed, reason: "read-only" };
        const claimed = await claimFilmSubmission(workspaceId, campaignId, run.id);
        if (!claimed) return { pumped: progressed, reason: "submit-in-flight" };
        try {
          const sourceUrl = await filmSourceUrl(workspaceId, campaignId, claimed);
          const parsed = await client.submitCreativeJob(submitArgsFor(claimed, sourceUrl));
          progressed = (await applySubmitResponse(workspaceId, campaignId, claimed, parsed, "submit")) || progressed;
        } catch (e) {
          logFilm("submit", e);
          await failFilmRun(
            workspaceId,
            campaignId,
            run.id,
            "Film submit failed before the provider returned a job id - nothing is tracked. Check the provider before retrying; retrying submits a new job."
          );
          return { pumped: true, reason: "submit-failed" };
        }
      } else if (action === "confirm_staged") {
        if (opts.allowConfirm === false) return { pumped: progressed, reason: "read-only" };
        const capRefusal = checkFilmCap(run.budgetCapUsd, run.estimateUsd);
        if (capRefusal) {
          await failFilmRun(workspaceId, campaignId, run.id, capRefusal);
          return { pumped: true, reason: "cap-refused" };
        }
        try {
          const parsed = await client.confirmCreativeJob(run.providerJobId as string);
          progressed = (await applySubmitResponse(workspaceId, campaignId, run, parsed, "confirm")) || progressed;
        } catch (e) {
          // The staged id is persisted: the next pump polls it instead of
          // re-confirming blindly, so a transient confirm failure loses nothing.
          logFilm("confirm", e);
          await writeFilmRun(workspaceId, campaignId, run.id, (r) => {
            r.providerStatus = "awaiting_confirmation";
            r.error = undefined;
          });
          return { pumped: progressed, reason: "confirm-transient" };
        }
      } else {
        try {
          const parsed = await client.getCreativeJob(run.providerJobId as string);
          progressed = (await applyStatusResponse(workspaceId, campaignId, run, parsed)) || progressed;
        } catch {
          // Transient probe failure - next pump retries, nothing lost.
          return { pumped: progressed, reason: "poll-transient" };
        }
      }
      if (Date.now() >= deadline) return { pumped: progressed };
      const fresh = (await readWorkspace(workspaceId)).campaigns.find((c) => c.id === campaignId);
      const freshRun = fresh ? findFilmRun(fresh, filmRunId) : undefined;
      if (!freshRun || freshRun.status === "ready" || freshRun.status === "failed" || freshRun.status === "cancelled") {
        return { pumped: true };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, Math.max(0, deadline - Date.now()))));
    }
  } finally {
    pumpLocks.delete(lockKey);
  }
}

/**
 * Cancel one film run: cancel ONLY the owned provider job (when one is
 * tracked and the run is still active), then mark the run cancelled.
 * Campaign jobs, receipts, runs, and the saved plan are never touched -
 * prior completed assets are preserved by construction.
 */
export async function cancelFilmRun(
  workspaceId: string,
  campaignId: string,
  filmRunId: string,
  client: FilmMcpClient = defaultClient()
): Promise<{ cancelled: boolean; providerConfirmed: boolean; note: string }> {
  const db = await readWorkspace(workspaceId);
  const campaign = db.campaigns.find((c) => c.id === campaignId);
  const run = campaign ? findFilmRun(campaign, filmRunId) : undefined;
  if (!run) return { cancelled: false, providerConfirmed: false, note: "Film run not found." };
  if (run.status === "ready") {
    return { cancelled: false, providerConfirmed: false, note: "Film run already delivered its reel - nothing to cancel." };
  }
  if (run.status === "failed" || run.status === "cancelled") {
    return { cancelled: false, providerConfirmed: run.providerCancelConfirmed ?? false, note: `Film run already ${run.status}.` };
  }
  let providerConfirmed = false;
  let providerNote = "No provider job was tracked - nothing was submitted.";
  const sceneJobIds = run.sceneOutputs.map((scene) => scene.providerJobId).filter((id): id is string => Boolean(id));
  const providerJobIds = [...new Set([run.providerJobId, run.assemblyJobId, ...sceneJobIds].filter((id): id is string => Boolean(id)))];
  if (providerJobIds.length > 0) {
    try {
      const results = await Promise.all(providerJobIds.map((jobId) =>
        client.cancelProviderJob ? client.cancelProviderJob(jobId) : client.cancelCreativeJob(jobId)
      ));
      providerConfirmed = results.every((result) => result.cancelled);
      providerNote = providerConfirmed ? "Provider confirmed cancellation." : "Provider did not confirm cancellation for every active job.";
    } catch (e) {
      logFilm("cancel", e);
      providerNote = "Provider cancel call failed - the run is marked cancelled locally; verify at the provider.";
    }
  }
  await writeFilmRun(workspaceId, campaignId, run.id, (r) => {
    if (r.status === "ready") return;
    r.status = "cancelled";
    r.submissionClaimedAt = undefined;
    r.providerCancelConfirmed = providerConfirmed;
    r.providerCancelNote = providerNote;
    r.finishedAt = nowIso();
  });
  return {
    cancelled: true,
    providerConfirmed,
    note: providerConfirmed
      ? "Film run cancelled; provider confirmed. Prior campaign assets are untouched."
      : `Film run cancelled locally. ${providerNote} Prior campaign assets are untouched.`
  };
}
