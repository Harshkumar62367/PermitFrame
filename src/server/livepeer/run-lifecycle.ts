import type { ProductionJob, ProductionRun } from "../types";
import { newId, nowIso } from "../store";
import { readWorkspace, writeWorkspace } from "./run-store";
import { LivepeerMcpClient, livepeerConfig } from "./mcp-client";
import { withCampaignLock } from "./mutex";
import { fetchLivePriceMap, quoteStage } from "./pricing";
import { isExactRun, runOwnsJob } from "./run-scope";
import type { PumpOptions, PumpResult } from "./run-poll";
import { STATUS_PUMP } from "./run-poll";

/**
 * Run lifecycle: failure/completion settlement, cancellation, spend
 * ledger, and status snapshots. Depends on scope (ownership) and leaf
 * modules only. The status snapshot takes its pump as an injected
 * dependency so this module never imports the orchestrator facade
 * (no cycle); the facade exposes the route-facing 3-argument wrapper.
 */

export interface CancelSplit {
  /** Never dispatched (queued, no provider id): safe local cancel. */
  local: ProductionJob[];
  /** Dispatched but pre-output: needs a provider cancel attempt. */
  provider: ProductionJob[];
  /** Everything else: left untouched with a reason. */
  skipped: { job: ProductionJob; reason: string }[];
}

/** Split cancel targets honestly - never claim what the provider must confirm. */
export function splitCancelTargets(jobs: ProductionJob[], ids?: string[]): CancelSplit {
  const wanted = ids && ids.length > 0 ? new Set(ids) : null;
  const split: CancelSplit = { local: [], provider: [], skipped: [] };
  for (const job of jobs) {
    if (wanted && !wanted.has(job.id)) continue;
    if (job.status === "queued" && !job.livepeerJobId) {
      split.local.push(job);
    } else if (job.status === "generating" && job.livepeerJobId) {
      split.provider.push(job);
    } else {
      split.skipped.push({
        job,
        reason:
          job.status === "queued"
            ? "Already handed to the provider - requesting provider cancellation instead."
            : `Status ${job.status}: only undispatched or in-flight jobs can be cancelled.`
      });
    }
  }
  // Queued jobs that already hold a provider id (submitted, id persisted,
  // result not yet observed) need the provider attempt, not local cancel.
  for (const job of jobs) {
    if (wanted && !wanted.has(job.id)) continue;
    if (job.status === "queued" && job.livepeerJobId && !split.provider.includes(job)) {
      split.provider.push(job);
    }
  }
  return split;
}

/** Fail every owned queued/generating job and settle the run. Scope-aware. */
export async function failRunStages(
  workspaceId: string,
  campaignId: string,
  run: ProductionRun,
  message: string
): Promise<void> {
  await withCampaignLock(campaignId, () =>
    writeWorkspace(workspaceId, (d) => {
      const c = d.campaigns.find((x) => x.id === campaignId);
      if (!c) return;
      for (const j of c.jobs) {
        if (runOwnsJob(run, j) && (j.status === "queued" || j.status === "generating")) {
          j.status = "failed";
          j.error = message.slice(0, 400);
          j.finishedAt = nowIso();
        }
      }
      const r = c.runs?.find((x) => x.id === run.id);
      if (r) {
        r.status = "complete";
        r.note = message.slice(0, 400);
        r.finishedAt = nowIso();
        r.updatedAt = nowIso();
      }
    })
  );
}

/** Settle a run: dispatch work (queued/generating) is over. Durable storage
 * (preview/storage workers, receipts) finalizes on the job rows detached -
 * "complete" never claims storage finished, only that no further dispatch
 * will happen under this run. */
export async function completeRun(workspaceId: string, campaignId: string, runId: string): Promise<void> {
  await withCampaignLock(campaignId, () =>
    writeWorkspace(workspaceId, (d) => {
      const c = d.campaigns.find((x) => x.id === campaignId);
      const r = c?.runs?.find((x) => x.id === runId);
      if (!c || !r || r.status !== "active") return;
      const jobs = c.jobs.filter((j) => runOwnsJob(r, j));
      const failed = jobs.filter((j) => j.status === "failed").length;
      const ready = jobs.filter((j) => j.status === "ready_to_share").length;
      const unit = isExactRun(r) ? "outputs" : "stages";
      r.status = "complete";
      r.note = `${ready}/${jobs.length} ${unit} ready${failed > 0 ? `, ${failed} failed (retry only those)` : ""}. Partial success preserved.`;
      r.finishedAt = nowIso();
      r.updatedAt = nowIso();
      c.status = "review";
      c.updatedAt = nowIso();
      d.events.push({
        id: newId("evt"),
        at: nowIso(),
        kind: "production.run",
        summary: `Production run ${runId} finished: ${ready}/${jobs.length} ${unit} ready.`,
        refs: [campaignId, runId]
      });
    })
  );
}

/* ------------------------- cancel ------------------------ */

export interface CancelResult {
  jobId: string;
  outcome: "cancelled" | "cancel-requested" | "provider-refused" | "skipped";
  detail: string;
}

/**
 * Cancel run jobs. Never-dispatched rows cancel locally; in-flight rows
 * get a real provider cancel attempt and are marked only on confirmation -
 * a refusal keeps the job untouched with an honest note.
 */
export async function cancelRunJobs(
  workspaceId: string,
  campaignId: string,
  jobIds?: string[]
): Promise<CancelResult[]> {
  const db = await readWorkspace(workspaceId);
  const campaign = db.campaigns.find((c) => c.id === campaignId);
  if (!campaign) return [];
  const split = splitCancelTargets(campaign.jobs, jobIds);
  const results: CancelResult[] = [];
  if (split.local.length > 0) {
    await withCampaignLock(campaignId, () =>
      writeWorkspace(workspaceId, (d) => {
        const ids = new Set(split.local.map((j) => j.id));
        for (const j of d.campaigns.find((x) => x.id === campaignId)?.jobs ?? []) {
          if (ids.has(j.id) && j.status === "queued" && !j.livepeerJobId) {
            j.status = "cancelled";
            j.finishedAt = nowIso();
          }
        }
      })
    );
    for (const j of split.local) {
      results.push({ jobId: j.id, outcome: "cancelled", detail: "Cancelled before dispatch - nothing was spent." });
    }
  }
  const client = new LivepeerMcpClient(livepeerConfig());
  for (const job of split.provider) {
    if (!job.livepeerJobId) {
      results.push({ jobId: job.id, outcome: "skipped", detail: "No provider job id recorded." });
      continue;
    }
    const attempt = await client.cancelProviderJob(job.livepeerJobId);
    if (attempt.cancelled) {
      const jobId = job.id;
      await withCampaignLock(campaignId, () =>
        writeWorkspace(workspaceId, (d) => {
          const j = d.campaigns.find((x) => x.id === campaignId)?.jobs.find((x) => x.id === jobId);
          if (j && (j.status === "generating" || j.status === "queued")) {
            j.status = "cancelled";
            j.finishedAt = nowIso();
          }
        })
      );
      results.push({ jobId: job.id, outcome: "cancelled", detail: attempt.note });
    } else {
      results.push({ jobId: job.id, outcome: "provider-refused", detail: attempt.note });
    }
  }
  for (const { job, reason } of split.skipped) {
    results.push({ jobId: job.id, outcome: "skipped", detail: reason });
  }
  return results;
}

/** Run spend ledger: pack estimate, actual, per-stage, cap. */
export async function runSpendLedger(
  workspaceId: string,
  campaignId: string,
  runId: string,
  livePrices?: Map<string, import("./pricing").LivePrice> | null
): Promise<{
  run?: ProductionRun;
  stages: { stageId: string; label: string; status: string; costUsd: number | null; estimateUsd: number | null; pricedCapability: string | null }[];
  estimateTotal: number | null;
  actualTotal: number;
  spendCapUsd?: number;
} | null> {
  const db = await readWorkspace(workspaceId);
  const campaign = db.campaigns.find((c) => c.id === campaignId);
  if (!campaign) return null;
  const run = campaign.runs?.find((r) => r.id === runId);
  if (!run) return null;
  // Explicit map only: callers that cannot wait (status route) pass the
  // cache peek, which may be null - estimates then read null, honestly.
  const live = livePrices === undefined ? await fetchLivePriceMap() : livePrices;
  const stages = [];
  let estimateTotal = 0;
  let quotable = false;
  let actualTotal = 0;
  // Exact runs price their listed jobs (two derivatives = two entries);
  // stage runs price the first job per stage, exactly as before.
  const pricedJobs = isExactRun(run)
    ? (run.jobIds as string[]).map((id) => campaign.jobs.find((j) => j.id === id)).filter((j): j is ProductionJob => !!j)
    : run.stageIds.map((stageId) => campaign.jobs.find((j) => j.stageId === stageId)).filter((j): j is ProductionJob => !!j);
  for (const job of pricedJobs) {
    const stageId = job.stageId;
    const stage = campaign.preflight?.plan.find((s) => s.id === stageId);
    // Estimate what would actually render: the structured actual model when
    // the job substituted (never display text), else the planned stage
    // model - always at the resolved duration, never the requested one.
    const estimateCap = job?.actualCapability ?? stage?.capability;
    const quote =
      stage && estimateCap
        ? quoteStage({ capability: estimateCap, kind: stage.kind }, live, stage.durationSeconds ?? 5)
        : null;
    if (quote) {
      quotable = true;
      estimateTotal += quote.usd;
    }
    if (typeof job?.costUsd === "number") actualTotal += job.costUsd;
    stages.push({
      stageId,
      label: stage?.label ?? stageId,
      status: job?.status ?? "queued",
      costUsd: job?.costUsd ?? null,
      estimateUsd: quote ? Math.round(quote.usd * 10000) / 10000 : null,
      pricedCapability: estimateCap ?? null
    });
  }
  return {
    run,
    stages,
    estimateTotal: quotable ? Math.round(estimateTotal * 10000) / 10000 : null,
    actualTotal: Math.round(actualTotal * 10000) / 10000,
    ...(run.spendCapUsd !== undefined ? { spendCapUsd: run.spendCapUsd } : {})
  };
}

export interface RunStatusSnapshot {
  run: ProductionRun;
  stages: { stageId: string; label: string; status: string; costUsd: number | null; estimateUsd: number | null; pricedCapability: string | null }[];
  jobs: { id: string; stageId: string; status: string; outputUrl: string | null; costUsd: number | null; error: string | null }[];
  progress: { ready: number; total: number };
  estimateTotal: number | null;
  actualTotal: number;
  spendCapUsd?: number;
}

/** Pump dependency for the status snapshot, injected by the orchestrator
 * facade (keeps this module cycle-free). */
export type SnapshotPump = (workspaceId: string, campaignId: string, opts: PumpOptions) => Promise<PumpResult>;

/**
 * Status-route logic: read/poll-only short pump first (returns fast), full
 * detached pump alongside (not awaited), ledger on cached prices only.
 */
export async function fetchRunStatusSnapshot(
  workspaceId: string,
  campaignId: string,
  runId: string,
  pump: SnapshotPump
): Promise<RunStatusSnapshot | null> {
  // Read/poll-only first (returns fast), then full progress detached (not
  // awaited) - this order matters: the per-campaign pump lock would
  // otherwise collapse the short poll into the long pump and the GET would
  // carry no fresh progress.
  await pump(workspaceId, campaignId, { runId, ...STATUS_PUMP }).catch(() => undefined);
  void pump(workspaceId, campaignId, { runId, budgetMs: 8 * 60 * 1000 }).catch(() => undefined);
  const db = await readWorkspace(workspaceId);
  const campaign = db.campaigns.find((c) => c.id === campaignId);
  const run = campaign?.runs?.find((r) => r.id === runId);
  if (!campaign || !run) return null;
  // Cached prices only: a cold cache yields null estimates (shown as
  // unquotable) instead of blocking on a live pricing call.
  const { peekLivePriceMap } = await import("./pricing");
  const ledger = await runSpendLedger(workspaceId, campaignId, runId, peekLivePriceMap());
  if (!ledger) return null;
  const jobs = (campaign.jobs ?? []).filter((j) => runOwnsJob(run, j));
  const ready = jobs.filter((j) => j.status === "ready_to_share").length;
  return {
    run: ledger.run as ProductionRun,
    stages: ledger.stages,
    jobs: jobs.map((j) => ({
      id: j.id,
      stageId: j.stageId,
      status: j.status,
      outputUrl: j.outputUrl ?? null,
      costUsd: j.costUsd ?? null,
      error: j.error ?? null
    })),
    progress: { ready, total: isExactRun(run) ? (run.jobIds as string[]).length : run.stageIds.length },
    estimateTotal: ledger.estimateTotal,
    actualTotal: ledger.actualTotal,
    ...(ledger.spendCapUsd !== undefined ? { spendCapUsd: ledger.spendCapUsd } : {})
  };
}
