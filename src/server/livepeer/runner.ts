import type { ProductionStagePlan } from "../types";
import { nowIso, sha256 } from "../store";
import { readWorkspace, writeWorkspace } from "./run-store";
import { LivepeerMcpClient, livepeerConfig } from "./mcp-client";
import {
  decideStageRuns,
  isUsableOutputUrl,
  normalizeQualityProfile,
  normalizeStagePlan,
  validatePlan
} from "./plan-dag";
import { failStageJobs, persistPreviewInBackground } from "./pipeline";
import { DEFAULT_MAX_CONCURRENCY, resolveMaxConcurrency } from "./run-retry";
import {
  failUnreadyExactJobs,
  isExactRun,
  runOwnsJob,
  selectDispatchable,
  selectExactSlots
} from "./run-scope";
import { dispatchSlot, prepareFailedProviderRecoveries } from "./run-dispatch";
import { delay, enforceWatchdogs, pollJob, resolveProgressHold, type PumpOptions, type PumpResult } from "./run-poll";
import { resolveSourceMediaUrl } from "../cloudinary";
import { withCampaignLock } from "./mutex";
import { completeRun, failRunStages, fetchRunStatusSnapshot, statusNeedsRecoveryPump, type RunStatusSnapshot } from "./run-lifecycle";

/**
 * Compatibility facade + pump orchestration (target <250 lines).
 *
 * All run behavior lives in the extracted modules - scope, retry, submit,
 * poll, dispatch, finalize, lifecycle - which this file wires together in
 * pumpRunInner and re-exports below. Existing `from "./runner"` imports
 * (routes, campaigns, tests) keep working unchanged; nothing here owns a
 * business rule except pass order, which is preserved verbatim.
 *
 * Async, resumable, progressive execution over the production DAG.
 *
 * Model: submission creates durable job records + a ProductionRun and
 * returns immediately. The dependency-aware pump advances the run in the
 * background (bounded concurrency, default 3) and any later request - or
 * a process restart - resumes from Neon-backed records.
 */

const pumpLocks = new Map<string, boolean>();

function pumpKey(campaignId: string): string {
  return `pump:${campaignId}`;
}

/**
 * Advance one campaign's active work: poll in-flight provider jobs, then
 * dispatch runnable stages within the concurrency ceiling. Bounded by
 * budgetMs; state persists every step so any later pump (or restart)
 * resumes. Concurrent pumps for one campaign collapse into one.
 */
export async function pumpRun(
  workspaceId: string,
  campaignId: string,
  opts: PumpOptions = {}
): Promise<PumpResult> {
  if (pumpLocks.get(pumpKey(campaignId))) return { pumped: false, reason: "already-running" };
  pumpLocks.set(pumpKey(campaignId), true);
  try {
    return await pumpRunInner(workspaceId, campaignId, opts);
  } finally {
    pumpLocks.delete(pumpKey(campaignId));
  }
}

async function reopenRunForRecovery(workspaceId: string, campaignId: string, runId: string): Promise<boolean> {
  let reopened = false;
  await withCampaignLock(campaignId, () =>
    writeWorkspace(workspaceId, (d) => {
      const campaign = d.campaigns.find((c) => c.id === campaignId);
      const run = campaign?.runs?.find((r) => r.id === runId);
      if (!campaign || !run || run.status !== "complete") return;
      run.status = "active";
      delete run.finishedAt;
      delete run.note;
      run.updatedAt = nowIso();
      campaign.status = "generating";
      campaign.updatedAt = nowIso();
      reopened = true;
    })
  );
  return reopened;
}

async function pumpRunInner(
  workspaceId: string,
  campaignId: string,
  opts: PumpOptions
): Promise<PumpResult> {
  const budgetMs = opts.budgetMs ?? 20_000;
  const deadline = Date.now() + budgetMs;
  const client = new LivepeerMcpClient(livepeerConfig());
  let progressed = false;

  for (;;) {
    if (Date.now() >= deadline) return { pumped: progressed, reason: progressed ? undefined : "budget" };
    let db = await readWorkspace(workspaceId);
    let campaign = db.campaigns.find((c) => c.id === campaignId);
    if (!campaign) return { pumped: progressed, reason: "not-found" };
    if (campaign.preflight?.decision !== "allow") return { pumped: progressed, reason: "blocked" };

    let run = opts.runId
      ? campaign.runs?.find((r) => r.id === opts.runId)
      : [...(campaign?.runs ?? [])].reverse().find((r) => r.status === "active");
    if (!run) return { pumped: progressed, reason: "no-active-run" };
    const ownedJobs = campaign.jobs.filter((j) => runOwnsJob(run!, j));
    let recoveredFailed = false;
    if (opts.recoverFailed && opts.allowRecovery !== false) {
      recoveredFailed = await prepareFailedProviderRecoveries(workspaceId, campaignId, ownedJobs);
    }
    const restartWork = recoveredFailed || statusNeedsRecoveryPump(ownedJobs);
    if (run.status !== "active") {
      if (
        run.status !== "complete" ||
        !restartWork ||
        !(await reopenRunForRecovery(workspaceId, campaignId, run.id))
      ) {
        return { pumped: progressed, reason: "no-active-run" };
      }
      db = await readWorkspace(workspaceId);
      campaign = db.campaigns.find((c) => c.id === campaignId);
      run = opts.runId
        ? campaign?.runs?.find((r) => r.id === opts.runId)
        : [...(campaign?.runs ?? [])].reverse().find((r) => r.status === "active");
      if (!campaign || !run) return { pumped: progressed, reason: "no-active-run" };
    } else if (recoveredFailed) {
      db = await readWorkspace(workspaceId);
      campaign = db.campaigns.find((c) => c.id === campaignId);
      run = opts.runId
        ? campaign?.runs?.find((r) => r.id === opts.runId)
        : [...(campaign?.runs ?? [])].reverse().find((r) => r.status === "active");
      if (!campaign || !run) return { pumped: progressed, reason: "no-active-run" };
    }
    if (restartWork) progressed = true;

    const profile = normalizeQualityProfile(
      campaign.request.qualityProfile ?? process.env.LIVEPEER_QUALITY_PROFILE
    );
    let stages: ProductionStagePlan[];
    try {
      stages = validatePlan(normalizeStagePlan(campaign.preflight?.plan ?? [], profile));
    } catch (error) {
      await failRunStages(workspaceId, campaignId, run, `Production plan is invalid: ${(error as Error).message}`);
      return { pumped: progressed, reason: "invalid-plan" };
    }
    const sourceMedia = db.sourceMedia.find((m) => m.id === campaign!.sourceMediaId);
    const resolveSource = opts.resolveSourceUrl ?? resolveSourceMediaUrl;
    const sourceMediaUrl = sourceMedia ? resolveSource(sourceMedia) : undefined;
    let runJobs = campaign.jobs.filter((j) => runOwnsJob(run!, j));
    if (await enforceWatchdogs(client, workspaceId, campaign, runJobs, Date.now(), opts.allowRecovery !== false)) {
      progressed = true;
      db = await readWorkspace(workspaceId);
      campaign = db.campaigns.find((c) => c.id === campaignId);
      if (!campaign) return { pumped: progressed, reason: "not-found" };
      run = opts.runId
        ? campaign.runs?.find((r) => r.id === opts.runId)
        : [...(campaign?.runs ?? [])].reverse().find((r) => r.status === "active");
      if (!run || run.status !== "active") return { pumped: progressed, reason: "no-active-run" };
      runJobs = campaign.jobs.filter((j) => runOwnsJob(run!, j));
    }
    // Exact runs bypass stage decisions entirely: owned derivative jobs get
    // one slot each (never first-match-by-stage), and no fail decision for
    // a stage can touch a job outside the exact list.
    const exact = isExactRun(run);
    const decisions = exact ? [] : decideStageRuns(stages, campaign.jobs, sourceMediaUrl, run.stageIds);
    const inFlight = runJobs.filter((j) => j.status === "generating" && j.livepeerJobId);

    // 1) Poll in-flight provider jobs (parallel network, serialized writes).
    // The hold is explicit per caller: short on the status route (STATUS_PUMP
    // keeps GETs inside the browser timeout), long on detached pumps.
    const holdSeconds = resolveProgressHold(opts.progressHoldSeconds);
    const pollResults = await Promise.allSettled(
       inFlight.map((job) => pollJob(client, workspaceId, campaign, job, holdSeconds, opts.allowRecovery !== false))
    );
    if (pollResults.some((r) => r.status === "fulfilled" && r.value)) progressed = true;

    // 2b) Resume detached finalization: preview jobs whose persist worker
    // died (e.g. process restart) get a fresh one. Compare-and-set keeps
    // live workers single and persistJobAsset is idempotent. storage_pending
    // rows stay manual-retry (Review & deliver) - the pump never claims to
    // auto-resume what it cannot prove safe. Disabled in status mode: the
    // route fires the detached pump for this instead of blocking the GET.
    const allowResume = opts.allowPreviewResume !== false;
    const previews = allowResume
      ? runJobs.filter(
          (j) => j.status === "preview_ready" && j.providerOutputUrl && isUsableOutputUrl(j.providerOutputUrl)
        )
      : [];
    for (const job of previews) {
      if (Date.now() >= deadline) break;
      void persistPreviewInBackground({
        workspaceId,
        campaignId,
        jobId: job.id,
        providerUrl: job.providerOutputUrl as string,
        promptHash: sha256(job.prompt),
        providerModel: job.capability,
        livepeerJobId: job.livepeerJobId,
        costUsd: job.costUsd,
        kind: job.kind
      }).catch(() => undefined);
    }
    const activeCount = runJobs.filter((j) => j.status === "generating").length;
    const ceiling = Math.min(run.maxConcurrency || DEFAULT_MAX_CONCURRENCY, resolveMaxConcurrency());
    // 2) Dispatch runnable stages within the ceiling - skipped entirely in
    // status mode (read/poll-only: no new provider work and no state writes
    // from a GET). Fail decisions apply only when the missing prerequisite
    // can never render: no job rows for the dependency (never selected),
    // or all of them terminally unready (failed/cancelled/storage-retry).
    // A queued or generating dependency stays queued and a later pass
    // dispatches the dependent. Application is idempotent - only queued or
    // generating rows match.
    const allowDispatch = opts.allowDispatch !== false;
    if (allowDispatch && !exact) {
      const terminalUnready = new Set(["failed", "cancelled", "storage_retry_needed"]);
      for (const decision of decisions) {
        if (decision.action !== "fail" || !decision.reason) continue;
        const depId =
          decision.stage.inputSource === "stage-output" ? decision.stage.dependsOnStageIds[0] : undefined;
        if (depId) {
          const depJobs = campaign.jobs.filter((j) => j.stageId === depId);
          if (depJobs.length > 0 && !depJobs.some((j) => terminalUnready.has(j.status))) continue;
        }
        await failStageJobs(campaign.id, decision.stage.id, decision.reason, workspaceId, run.jobIds);
      }
    }
    if (allowDispatch && exact) {
      await failUnreadyExactJobs({ workspaceId, campaign, run, stages, sourceMediaUrl });
    }
    const slots = allowDispatch
      ? exact
        ? selectExactSlots(stages, runJobs, campaign.jobs, sourceMediaUrl, activeCount, ceiling)
        : selectDispatchable(decisions, runJobs, activeCount, ceiling)
      : [];
    if (slots.length > 0) {
      const spent = runJobs.reduce((sum, j) => sum + (j.costUsd ?? 0), 0);
      const results = await Promise.allSettled(
        slots.map((slot) => dispatchSlot(client, workspaceId, campaign, run, slot, spent))
      );
      if (results.some((r) => r.status === "fulfilled" && r.value)) progressed = true;
    }

    // 3) Settle the run when no queued or in-flight dispatch work remains.
    // (Preview persist + receipt workers finish detached - dispatch scope
    // is what the run tracks; delivery finalizes on the job rows.)
    // Ownership decides: an exact run completes when ITS jobs settle, even
    // if unrelated same-stage jobs are still working elsewhere.
    const fresh = (await readWorkspace(workspaceId)).campaigns.find((c) => c.id === campaignId);
    const freshJobs = (fresh?.jobs ?? []).filter((j) => runOwnsJob(run, j));
    const unsettled = freshJobs.some((j) => j.status === "queued" || j.status === "generating");
    if (!unsettled) {
      await completeRun(workspaceId, campaignId, run.id);
      return { pumped: true };
    }
    // Idle but in-flight work pending elsewhere (preview persist workers):
    // stop burning budget when nothing progressed and slots are empty.
    if (slots.length === 0 && inFlight.length === 0 && !progressed) {
      return { pumped: false, reason: "idle" };
    }
    if (Date.now() >= deadline) return { pumped: progressed };
    // Brief pause between passes; bounded by the remaining budget.
    await delay(Math.min(2000, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Status-route logic, extracted for testability: read/poll-only short pump
 * first (returns fast), full detached pump alongside (not awaited), ledger
 * on cached prices only. The route itself only handles auth/HTTP. Pump is
 * injected into the lifecycle module to keep the import graph cycle-free.
 */
export async function getRunStatusSnapshot(
  workspaceId: string,
  campaignId: string,
  runId: string
): Promise<RunStatusSnapshot | null> {
  return fetchRunStatusSnapshot(workspaceId, campaignId, runId, pumpRun);
}

/* ------------------------- public API (re-exported) ----------------------
 * Every name formerly exported from this file still imports from here.
 * Ownership: retry, scope, submit, poll, dispatch, finalize, lifecycle. */

export type { SubmitErrorKind, PlaceSubjectMode } from "./run-retry";
export {
  DEFAULT_MAX_CONCURRENCY, resolveMaxConcurrency, maxDispatchAttempts, maxAutomaticRecoveryAttempts,
  computeBackoffMs, classifySubmitError, classifyProviderFailure, isBackoffPending, redactSubmitError,
  placeSubjectMode, qualityCheckEnabled, DEFAULT_PROVIDER_BUDGET_SECONDS, PROVIDER_WATCHDOG_GRACE_SECONDS,
  MAX_PROVIDER_WATCHDOG_SECONDS, DEFAULT_PROVIDER_WATCHDOG_SECONDS, providerWatchdogSeconds
} from "./run-retry";
export type { DispatchSlot } from "./run-scope";
export {
  selectDispatchable, isExactRun, runOwnsJob, selectExactSlots, findActiveRun, preservationContextFor
} from "./run-scope";
export type { JobNextAction, PumpResult, PumpOptions } from "./run-poll";
export {
  nextJobAction, STATUS_PUMP, resolveProgressHold, pollProviderJob, watchdogDeadlineMs,
  isWatchdogExpired, enforceWatchdogs
} from "./run-poll";
export type { SubmitOutcome, ProviderRecoveryAction, ProviderRecoveryInput } from "./run-dispatch";
export { classifySubmitResult, shouldDispatchUnderCap, provenanceMeta, jobIdempotencyKey, prepareProviderRecovery } from "./run-dispatch";
export type { SubmitInput, SubmitResult } from "./run-submit";
export { submitRun } from "./run-submit";
export type { DispatchInput, PreservationOutcome } from "./run-finalize";
export { finalizedPreviewFields } from "./run-finalize";
export type { CancelSplit, CancelResult, RunStatusSnapshot } from "./run-lifecycle";
export { splitCancelTargets, cancelRunJobs, runSpendLedger, statusNeedsRecoveryPump } from "./run-lifecycle";
