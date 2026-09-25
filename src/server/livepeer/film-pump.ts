import type { Campaign, Database } from "../types";
import { newId, nowIso, sha256 } from "../store";
import { throwIfArchived } from "../campaign-lifecycle";
import { readWorkspace, writeWorkspace } from "./run-store";
import { withCampaignLock } from "./mutex";
import { LivepeerMcpClient, livepeerConfig } from "./mcp-client";
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
  isFilmWatchdogExpired,
  nextFilmAction,
  type FilmRun,
  type FilmRunStatus
} from "./film-run";
import { classifyProviderFailure, providerWatchdogSeconds } from "./run-retry";
import { isUsableOutputUrl } from "./plan-dag";
import { redactSecrets } from "../dkg/edge-node-adapter";

/**
 * Campaign Film execution: a separate, durable path from the short-clip
 * runner. One FilmRun owns exactly one provider creative job; the provider
 * id is persisted before any poll/confirm so retry and resume never submit
 * a second paid job (the observed submit schema carries no idempotency
 * key - stability comes from the persisted id plus the stable per-run
 * session tag). Short-clip state (jobs, receipts, runs, preflight, plan)
 * is never read for decisions and never written. No DKG, no audio.
 */

/** Minimal provider surface the film pump needs (LivepeerMcpClient satisfies it structurally). */
export interface FilmMcpClient {
  submitCreativeJob(args: CreativeSubmitArgs): Promise<CreativeSubmitParsed>;
  confirmCreativeJob(providerJobId: string): Promise<CreativeSubmitParsed>;
  getCreativeJob(jobId: string): Promise<CreativeStatusParsed>;
  cancelCreativeJob(jobId: string, transportTimeoutMs?: number): Promise<{ cancelled: boolean; note: string }>;
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
    current.dispatchStartedAt = undefined;
    current.providerBudgetSeconds = undefined;
    current.dispatchBudgetSeconds = undefined;
    current.dispatchDeadlineAt = undefined;
    current.providerStatus = "timeout";
    current.error = "Film job exceeded its dispatch budget without a reel. No provider job remains active; submit a new run to retry.";
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
    providerSessionId: `permitframe_${newId("filmrun").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60)}`,
    status: "confirmed",
    requestedCapability: "submit_creative_job (provider-routed scenes)",
    sceneOutputs: [],
    preservation: {
      requested: "source-guided-generation",
      evidenceLevel: "none",
      note: "Scene prompts reference the approved source media in text; no reference image was sent to the provider and no preservation tool ran."
    },
    ...(key ? { idempotencyKey: key } : {}),
    createdAt: now,
    updatedAt: now
  };
  await withCampaignLock(input.campaignId, () =>
    writeWorkspace(input.workspaceId, (d: Database) => {
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
    })
  );
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
    })
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
    run.dispatchStartedAt = undefined;
    run.providerBudgetSeconds = undefined;
    run.dispatchBudgetSeconds = undefined;
    run.dispatchDeadlineAt = undefined;
    run.finishedAt = nowIso();
  });
}

function submitArgsFor(run: FilmRun): CreativeSubmitArgs {
  return buildCreativeSubmitArgs(
    {
      title: run.filmTitle,
      targetDurationSeconds: run.targetDurationSeconds,
      aspectRatio: run.aspectRatio,
      budgetCapUsd: run.budgetCapUsd,
      scenes: run.plannedScenes
    },
    run.providerSessionId
  );
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
    r.providerJobId = parsed.providerJobId as string;
    r.lastProviderJobId = parsed.providerJobId as string;
    r.providerStatus = parsed.awaitingConfirmation ? "awaiting_confirmation" : "submitted";
    r.status = "submitting";
    r.dispatchStartedAt = r.dispatchStartedAt ?? nowIso();
    if (parsed.budgetSeconds !== undefined) r.providerBudgetSeconds = parsed.budgetSeconds;
    r.dispatchBudgetSeconds = providerWatchdogSeconds(parsed.budgetSeconds);
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
    r.providerStatus = gate ? "awaiting_confirmation" : parsed.statusText || r.providerStatus;
    r.status = gate ? "submitting" : nextStatus;
    r.sceneOutputs = parsed.sceneOutputs.map((s) => ({ ...s }));
    if (parsed.costUsd !== undefined) r.costUsd = parsed.costUsd;
    if (parsed.estimateUsd !== undefined) r.estimateUsd = parsed.estimateUsd;
    if (parsed.capability) r.actualCapability = parsed.capability;
    if (parsed.budgetSeconds !== undefined) {
      r.providerBudgetSeconds = parsed.budgetSeconds;
      r.dispatchBudgetSeconds = providerWatchdogSeconds(parsed.budgetSeconds);
      const anchor = Date.parse(r.dispatchStartedAt ?? "");
      if (Number.isFinite(anchor)) r.dispatchDeadlineAt = new Date(anchor + r.dispatchBudgetSeconds * 1000).toISOString();
    }
    if (nextStatus === "ready" && parsed.reelUrl) r.reelUrl = parsed.reelUrl;
    if (error) {
      r.error = error;
      r.providerFailureKind = classifyProviderFailure(parsed.statusText, typeof parsed.raw.error === "string" ? parsed.raw.error : undefined) ?? "failed_without_output";
      r.lastProviderJobId = r.lastProviderJobId ?? r.providerJobId;
      r.providerJobId = undefined;
      r.dispatchStartedAt = undefined;
      r.providerBudgetSeconds = undefined;
      r.dispatchBudgetSeconds = undefined;
      r.dispatchDeadlineAt = undefined;
      r.finishedAt = nowIso();
    } else if (nextStatus === "ready") {
      r.error = undefined;
      r.dispatchStartedAt = undefined;
      r.providerBudgetSeconds = undefined;
      r.dispatchBudgetSeconds = undefined;
      r.dispatchDeadlineAt = undefined;
      r.finishedAt = nowIso();
    }
  });
  return true;
}

/**
 * Advance one film run: submit (persist id first), confirm a staged gate
 * inside the cap, or poll. Bounded by budgetMs; every step persists so any
 * later pump - or a process restart - resumes from the stored provider id
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
        await writeFilmRun(workspaceId, campaignId, run.id, (current) => {
          if (current.providerJobId) return;
           current.status = "submitting";
           current.dispatchStartedAt = nowIso();
           current.providerBudgetSeconds = undefined;
           current.dispatchBudgetSeconds = providerWatchdogSeconds();
          current.dispatchDeadlineAt = new Date(Date.parse(current.dispatchStartedAt) + current.dispatchBudgetSeconds * 1000).toISOString();
        });
        try {
          const parsed = await client.submitCreativeJob(submitArgsFor(run));
          progressed = (await applySubmitResponse(workspaceId, campaignId, run, parsed, "submit")) || progressed;
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
  if (run.providerJobId) {
    try {
      const result = await client.cancelCreativeJob(run.providerJobId);
      providerConfirmed = result.cancelled;
      providerNote = result.note;
    } catch (e) {
      logFilm("cancel", e);
      providerNote = "Provider cancel call failed - the run is marked cancelled locally; verify at the provider.";
    }
  }
  await writeFilmRun(workspaceId, campaignId, run.id, (r) => {
    if (r.status === "ready") return;
    r.status = "cancelled";
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
