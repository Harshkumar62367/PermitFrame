import type {
  Campaign,
  Database,
  ProductionJob,
  ProductionRun,
  ProductionStagePlan,
  StageInputSource
} from "../types";
import { newId, nowIso, sha256, updateDb } from "../store";
import { readWorkspace, writeWorkspace } from "./run-store";
import { LivepeerMcpClient, livepeerConfig } from "./mcp-client";
import { assertCapabilityAvailable } from "./catalogue";
import { fetchLivePriceMap, quoteStage, stageSpendingCeiling } from "./pricing";
import { resolveMotionDuration } from "./duration-policy";
import {
  decideStageRuns,
  isUsableOutputUrl,
  normalizeQualityProfile,
  normalizeStagePlan,
  prerequisiteMessage,
  resolveStageInput,
  seedStageOutputs,
  validatePlan,
  type StageRunDecision
} from "./plan-dag";
import {
  classifyPreservationResult,
  preservationOperationKey,
  resolvePreservation,
  type PreservationCallOutcome,
  type PreservationCapability,
  type PreservationDecision
} from "./preservation-policy";
import type { PreservationEvidenceLevel } from "@/lib/preservation";
import { withCampaignLock } from "./mutex";
import { maskOperationalDetail } from "../dkg/public-errors";
import { checkAssetsPerRun, checkProfileAccess, resolveEntitlements } from "../entitlements";
import {
  createJobRecords,
  failStageJobs,
  persistPreviewInBackground
} from "./pipeline";

/**
 * Async, resumable, progressive execution over the production DAG.
 *
 * Model: submission creates durable job records + a ProductionRun and
 * returns immediately. The dependency-aware pump advances the run in the
 * background (bounded concurrency, default 3) and any later request - or
 * a process restart - resumes from Neon-backed records. No Redis, no
 * additional infrastructure: the always-on container plus durable state.
 *
 * - Independent image jobs dispatch concurrently (up to the ceiling).
 * - Motion/upscale wait for their declared dependency outputs.
 * - One failed independent asset never cancels unrelated assets.
 * - Re-dispatch after a network timeout reuses the same idempotency key;
 *   jobs that already hold a provider id are polled, never re-submitted.
 */

export const DEFAULT_MAX_CONCURRENCY = 3;

/** Effective concurrency ceiling: env override capped by the tier. */
export function resolveMaxConcurrency(): number {
  const tier = resolveEntitlements().maxConcurrentJobs;
  const env = Number.parseInt(process.env.LIVEPEER_MAX_CONCURRENCY ?? "", 10);
  const base = Number.isInteger(env) && env > 0 ? env : DEFAULT_MAX_CONCURRENCY;
  return Math.min(base, tier);
}

/** Max submit attempts per job before the stage fails honestly. */
export function maxDispatchAttempts(): number {
  const env = Number.parseInt(process.env.LIVEPEER_MAX_ATTEMPTS ?? "", 10);
  return Number.isInteger(env) && env > 0 ? env : 5;
}

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 15 * 60_000;

/** Exponential backoff after a failed attempt: 30s, 1m, 2m, 4m … capped at 15m. */
export function computeBackoffMs(attempts: number): number {
  if (!Number.isFinite(attempts) || attempts <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
}

export type SubmitErrorKind = "transient" | "terminal";

/**
 * Terminal rejections (capability gone, invalid input, cost refusal, auth)
 * fail the stage immediately; everything else (timeouts, transport, 5xx,
 * rate limits) is transient and retries with backoff under the same
 * idempotency key.
 */
export function classifySubmitError(message: string): SubmitErrorKind {
  if (
    /not currently available|unsupported|not supported|invalid|rejected|forbidden|unauthorized|exceeds|exceeded|payment|budget|blocked|denied/i.test(
      message
    )
  ) {
    return "terminal";
  }
  return "transient";
}

/** True while a job waits out its persisted backoff window. */
export function isBackoffPending(job: ProductionJob, now = Date.now()): boolean {
  if (job.status !== "queued" && job.status !== "generating") return false;
  if (!job.nextAttemptAt) return false;
  const at = Date.parse(job.nextAttemptAt);
  return Number.isFinite(at) && at > now;
}

/** Strip credential-shaped material before persisting an error. */
export function redactSubmitError(message: string): string {
  return maskOperationalDetail(
    message
      .replace(/bearer\s+[^\s]+/gi, "bearer [redacted]")
      .replace(/(api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, "$1 [redacted]")
  ).slice(0, 200);
}

export type PlaceSubjectMode = "auto" | "off";

/** place_subject is schema-validated but response-shape unproven: auto tries it, off skips. */
export function placeSubjectMode(): PlaceSubjectMode {
  return process.env.LIVEPEER_PLACE_SUBJECT === "off" ? "off" : "auto";
}

/** Advisory vision check kill-switch (default on; never fails a stage). */
export function qualityCheckEnabled(): boolean {
  return process.env.LIVEPEER_QUALITY_CHECK !== "off";
}

/* ------------------------- pure decision helpers ------------------------ */

export interface DispatchSlot {
  job: ProductionJob;
  inputUrl: string;
  resolvedInputSource: StageInputSource;
  sourceStageId?: string;
}

/**
 * Order-preserving dispatch selection: walk run decisions in dependency
 * order, taking runnable stages until in-flight + new fills the ceiling.
 * Jobs waiting out a persisted backoff window are skipped (resumed by a
 * later pump). Pure - concurrency and ordering are unit-testable.
 */
export function selectDispatchable(
  decisions: StageRunDecision[],
  jobs: ProductionJob[],
  activeCount: number,
  ceiling: number,
  now = Date.now()
): DispatchSlot[] {
  const slots: DispatchSlot[] = [];
  if (ceiling <= activeCount) return slots;
  for (const decision of decisions) {
    if (slots.length + activeCount >= ceiling) break;
    if (decision.action !== "run" || !decision.inputUrl) continue;
    const job = jobs.find(
      (j) =>
        j.stageId === decision.stage.id &&
        (j.status === "queued" || (j.status === "generating" && !j.outputUrl && !j.livepeerJobId))
    );
    if (!job || isBackoffPending(job, now)) continue;
    slots.push({
      job,
      inputUrl: decision.inputUrl,
      resolvedInputSource: decision.resolvedInputSource ?? decision.stage.inputSource,
      ...(decision.sourceStageId ? { sourceStageId: decision.sourceStageId } : {})
    });
  }
  return slots;
}

/** Exact-job scope present: this run addresses job ids, never stage ids. */
export function isExactRun(run: Pick<ProductionRun, "jobIds">): boolean {
  return !!run.jobIds && run.jobIds.length > 0;
}

/**
 * Run ownership predicate - the single gate for every run operation.
 * Exact runs own ONLY their listed job ids (a sibling sharing a stageId is
 * never owned); legacy runs own every job on their stages, unchanged.
 */
export function runOwnsJob(run: Pick<ProductionRun, "jobIds" | "stageIds">, job: Pick<ProductionJob, "id" | "stageId">): boolean {
  if (isExactRun(run)) return (run.jobIds as string[]).includes(job.id);
  return run.stageIds.includes(job.stageId);
}

/**
 * Dispatch slots for exact-job runs (variation/refinement derivatives).
 * One slot per owned runnable job - never first-match-by-stage, so two
 * derivatives sharing a stageId each dispatch under their own job id and
 * idempotency key. Inputs resolve per job through the same
 * resolveStageInput rules as the DAG (dependency outputs for motion-like
 * kinds, approved source otherwise); unresolvable inputs yield no slot and
 * are failed honestly by the exact fail pass below. Pure.
 */
export function selectExactSlots(
  stages: ProductionStagePlan[],
  ownedJobs: ProductionJob[],
  allJobs: ProductionJob[],
  sourceMediaUrl: string | undefined,
  activeCount: number,
  ceiling: number,
  now = Date.now()
): DispatchSlot[] {
  const slots: DispatchSlot[] = [];
  if (ceiling <= activeCount) return slots;
  const stageOutputs = seedStageOutputs(allJobs);
  for (const job of ownedJobs) {
    if (slots.length + activeCount >= ceiling) break;
    if (
      job.status !== "queued" &&
      !(job.status === "generating" && !job.outputUrl && !job.livepeerJobId)
    ) {
      continue;
    }
    const stage = stages.find((s) => s.id === job.stageId);
    if (!stage) continue;
    const resolved = resolveStageInput(stage, { sourceMediaUrl, stageOutputs });
    if (!resolved.url) continue;
    if (isBackoffPending(job, now)) continue;
    slots.push({
      job,
      inputUrl: resolved.url,
      resolvedInputSource: resolved.resolvedInputSource,
      ...(resolved.sourceStageId ? { sourceStageId: resolved.sourceStageId } : {})
    });
  }
  return slots;
}

export type JobNextAction = "poll" | "submit" | "ignore";

/**
 * Resume-safe per-job action: a generating job holding a provider id is
 * polled (never re-submitted - no duplicate paid jobs); queued or stale
 * rows without an id submit; everything else is ignored.
 */
export function nextJobAction(job: ProductionJob): JobNextAction {
  if (job.status === "generating" && job.livepeerJobId) return "poll";
  if (job.status === "queued") return "submit";
  if (job.status === "generating" && !job.outputUrl && !job.livepeerJobId) return "submit";
  return "ignore";
}

export type SubmitOutcome =
  | { action: "finalize"; providerUrl: string; costUsd?: number; capability?: string }
  | { action: "track"; jobId: string }
  | { action: "fail"; reason: string };

/**
 * Classify an async submit result. Inline usable outputs finalize
 * immediately (no provider id needed, none invented); a non-empty provider
 * id tracks for polling; neither fails honestly. Never an empty-string id.
 */
export function classifySubmitResult(result: {
  jobId?: string;
  outputUrl?: string;
  costUsd?: number;
  capability?: string;
}): SubmitOutcome {
  if (result.outputUrl && isUsableOutputUrl(result.outputUrl)) {
    return {
      action: "finalize",
      providerUrl: result.outputUrl,
      ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      ...(result.capability ? { capability: result.capability } : {})
    };
  }
  if (result.jobId && result.jobId.trim().length > 0) {
    return { action: "track", jobId: result.jobId };
  }
  return {
    action: "fail",
    reason: "Livepeer accepted the call but returned neither a usable output nor a provider job id - nothing was dispatched."
  };
}

/** Spend-cap gate before a dispatch. Unknown estimates never block. */
export function shouldDispatchUnderCap(
  spentUsd: number,
  stageEstimateUsd: number | null,
  capUsd: number | undefined
): { ok: boolean; reason?: string } {
  if (capUsd === undefined) return { ok: true };
  if (stageEstimateUsd === null) return { ok: true };
  if (spentUsd + stageEstimateUsd > capUsd) {
    return {
      ok: false,
      reason: `Dispatch refused: $${spentUsd.toFixed(2)} spent + $${stageEstimateUsd.toFixed(2)} estimated exceeds the $${capUsd.toFixed(2)} cap.`
    };
  }
  return { ok: true };
}

/**
 * Find a resumable run: same idempotency key first, else an active run for
 * the same scope. Exact-job submits only match exact runs with the same job
 * set; stage submits only match stage-scoped runs with the same stage set -
 * a variation run never dedupes (or collides with) a pack run sharing its
 * stage, and vice versa.
 */
export function findActiveRun(
  runs: ProductionRun[] | undefined,
  idempotencyKey: string | undefined,
  stageIds: string[],
  jobIds?: string[]
): ProductionRun | undefined {
  const list = runs ?? [];
  if (idempotencyKey) {
    const byKey = list.find((r) => r.status === "active" && r.idempotencyKey === idempotencyKey);
    if (byKey) return byKey;
  }
  const exact = !!jobIds && jobIds.length > 0;
  if (exact) {
    const wanted = new Set(jobIds as string[]);
    return list.find(
      (r) => r.status === "active" && isExactRun(r) && (r.jobIds as string[]).length === wanted.size && (r.jobIds as string[]).every((j) => wanted.has(j))
    );
  }
  const wanted = new Set(stageIds);
  return list.find(
    (r) => r.status === "active" && !isExactRun(r) && r.stageIds.length === wanted.size && r.stageIds.every((s) => wanted.has(s))
  );
}

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

/* ------------------------- submit (fast, sync part) ---------------------- */

export interface SubmitInput {
  campaignId: string;
  stageIds?: string[];
  /**
   * Exact-job scope: submit a run addressing ONLY these job ids
   * (variation/refinement derivatives). The jobs must already exist;
   * nothing is created or reset outside the list. Omit for normal
   * stage/DAG-scoped pack production.
   */
  jobIds?: string[];
  capabilityOverride?: string;
  idempotencyKey?: string;
  maxConcurrency?: number;
  /** Resolved in request scope; the detached pump needs it (no session there). */
  workspaceId?: string;
}

export interface SubmitResult {
  run?: ProductionRun;
  created: boolean;
  workspaceId?: string;
  error?: string;
}

async function estimateStages(
  stages: ProductionStagePlan[],
  durationFallback = 5
): Promise<{ total: number | null; exact: boolean }> {
  const live = await fetchLivePriceMap();
  let total = 0;
  let exact = true;
  let quotable = false;
  for (const s of stages) {
    const quote = quoteStage(
      { capability: s.capability, kind: s.kind },
      live,
      s.durationSeconds ?? durationFallback
    );
    if (!quote) {
      exact = false;
      continue;
    }
    quotable = true;
    total += quote.usd;
    if (!quote.exact) exact = false;
  }
  return { total: quotable ? Math.round(total * 10000) / 10000 : null, exact };
}

/**
 * Submit a run: validate, create durable job records, persist the run, and
 * return immediately. Never dispatches - the pump does that. Repeats with
 * the same idempotency key return the existing active run.
 *
 * Exact-job submits (jobIds) address only those jobs: no records are
 * created, no sibling sharing a stageId is reset, and the run carries the
 * exact scope so every later operation stays on those jobs.
 */
export async function submitRun(input: SubmitInput): Promise<SubmitResult> {
  // Workspace-scoped read when available (detached-safe); session read in
  // request scope. All writes below go through the run-store seam (live =
  // the same Neon workspace blob production uses; tests swap memory in).
  const campaign = input.workspaceId
    ? (await readWorkspace(input.workspaceId)).campaigns.find((c) => c.id === input.campaignId)
    : await (await import("../campaigns")).loadCampaign(input.campaignId);
  if (!campaign) return { created: false, error: "Campaign not found" };
  if (campaign.preflight?.decision !== "allow") {
    return { created: false, error: "Preflight has not approved this campaign" };
  }
  const write: (mutator: (db: Database) => void) => Promise<unknown> = (mutator) =>
    input.workspaceId ? writeWorkspace(input.workspaceId, mutator) : updateDb(mutator);
  const exactIds = input.jobIds && input.jobIds.length > 0 ? [...new Set(input.jobIds)] : undefined;
  let exactJobs: ProductionJob[] | undefined;
  if (exactIds) {
    exactJobs = [];
    for (const id of exactIds) {
      const job = campaign.jobs.find((j) => j.id === id);
      if (!job) return { created: false, error: `Unknown job ${id} - nothing was submitted.` };
      exactJobs.push(job);
    }
  }
  const planIds = (campaign.preflight?.plan ?? []).map((s) => s.id);
  const wanted =
    exactJobs && exactJobs.length > 0
      ? [...new Set(exactJobs.map((j) => j.stageId))].filter((s) => planIds.includes(s))
      : input.stageIds && input.stageIds.length > 0
        ? input.stageIds.filter((s) => planIds.includes(s))
        : planIds;
  if (exactJobs && wanted.length === 0) {
    return { created: false, error: "Exact jobs reference no known plan stage - nothing was submitted." };
  }
  if (wanted.length === 0) return { created: false, error: "No matching plan stages selected" };

  const tier = resolveEntitlements();
  const perRun = checkAssetsPerRun(exactJobs ? exactJobs.length : wanted.length, tier);
  if (perRun) return { created: false, error: perRun };
  const profileGate = checkProfileAccess(
    campaign.request.qualityProfile ??
      campaign.jobs.find((j) => wanted.includes(j.stageId))?.qualityProfile ??
      "balanced",
    tier
  );
  if (profileGate) return { created: false, error: profileGate };

  const existing = findActiveRun(campaign.runs, input.idempotencyKey?.trim() || undefined, wanted, exactIds);
  if (existing) {
    return { run: existing, created: false, workspaceId: input.workspaceId };
  }

  // Server-side duration re-resolution: stored resolved values are never
  // trusted. Rejections refuse the submit; adjustments rewrite the plan
  // rows below and are reported in the run event.
  const durationFixes: { stageId: string; requested: number; resolved: number; reason: string }[] = [];
  for (const stage of campaign.preflight?.plan ?? []) {
    if (!wanted.includes(stage.id) || stage.kind !== "image-to-video") continue;
    const requested = stage.requestedDurationSeconds ?? stage.durationSeconds ?? 5;
    const resolved = resolveMotionDuration(requested, stage.capability);
    if (!resolved.ok) {
      return { created: false, error: `"${stage.label}": ${resolved.error}` };
    }
    if (resolved.adjusted) {
      durationFixes.push({
        stageId: stage.id,
        requested: resolved.requestedSeconds,
        resolved: resolved.resolvedSeconds,
        reason: resolved.adjustmentReason ?? "Duration adjusted to a supported clip length."
      });
    }
  }

  const now = nowIso();
  const exactScope = exactJobs ? exactJobs.map((j) => j.id) : undefined;
  const run: ProductionRun = {
    id: newId("run"),
    campaignId: input.campaignId,
    stageIds: wanted,
    ...(exactScope ? { jobIds: exactScope } : {}),
    status: "active",
    ...(input.idempotencyKey?.trim() ? { idempotencyKey: input.idempotencyKey.trim() } : {}),
    maxConcurrency: Math.min(input.maxConcurrency ?? resolveMaxConcurrency(), tier.maxConcurrentJobs),
    ...(campaign.request.productionSpec?.maxSpendCapUsd !== undefined
      ? { spendCapUsd: campaign.request.productionSpec.maxSpendCapUsd }
      : {}),
    createdAt: now,
    updatedAt: now
  };

  const resetIds: string[] = [];
  const owned = exactScope ? new Set(exactScope) : null;
  await write((d) => {
    const c = d.campaigns.find((x) => x.id === input.campaignId);
    if (!c) return;
    // Resume: keep delivered stages, reset failed ones for the run's scope.
    // Exact runs reset ONLY their listed jobs - a sibling sharing a stageId
    // is never touched merely for sharing it.
    for (const j of c.jobs) {
      if ((j.status === "failed" || j.status === "storage_retry_needed") && (owned ? owned.has(j.id) : wanted.includes(j.stageId))) {
        if (input.capabilityOverride?.trim()) j.capability = input.capabilityOverride.trim();
        j.status = "queued";
        j.error = undefined;
        j.livepeerJobId = undefined;
        j.runId = run.id;
        resetIds.push(j.id);
      }
    }
    // Exact runs address pre-created derivative jobs: no record creation,
    // so the original stage is never re-run and readiness never shifts.
    if (!owned) {
      const covered = new Set(c.jobs.map((j) => j.stageId));
      const profile =
        campaign.request.qualityProfile ?? process.env.LIVEPEER_QUALITY_PROFILE ?? "balanced";
      const plan = normalizeStagePlan(c.preflight?.plan ?? [], normalizeQualityProfile(profile));
      for (const stageId of wanted) {
        if (covered.has(stageId)) continue;
        const stage = plan.find((s) => s.id === stageId);
        if (!stage) continue;
        const [job] = createJobRecords(
          { ...campaign, preflight: c.preflight },
          [stageId]
        );
        if (input.capabilityOverride?.trim()) job.capability = input.capabilityOverride.trim();
        job.runId = run.id;
        c.jobs.push(job);
      }
    }
    c.runs = [...(c.runs ?? []), run];
    c.status = "generating";
    c.updatedAt = nowIso();
    // Persist re-resolved durations onto the plan rows (requested kept).
    for (const fix of durationFixes) {
      const stage = c.preflight?.plan.find((s) => s.id === fix.stageId);
      if (stage && stage.kind === "image-to-video") {
        stage.durationSeconds = fix.resolved;
        stage.requestedDurationSeconds = fix.requested;
        stage.durationNote = fix.reason;
      }
    }
    if (c.request.productionSpec && durationFixes.length > 0) {
      c.request.productionSpec.resolvedMotionSeconds = durationFixes[0].resolved;
    }
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "production.start",
      summary: owned
        ? `Livepeer exact-job run ${run.id} submitted for "${c.title}" - ${exactScope?.length} job${exactScope?.length === 1 ? "" : "s"} (sibling jobs sharing a stage are untouched). Only preflight-approved stages may run.${durationFixes.length > 0 ? ` Duration adjustments: ${durationFixes.map((f) => `${f.requested}s→${f.resolved}s`).join(", ")}.` : ""}`
        : `Livepeer production run ${run.id} submitted for "${c.title}" - ${wanted.length} stage${wanted.length === 1 ? "" : "s"}. Only preflight-approved stages may run.${durationFixes.length > 0 ? ` Duration adjustments: ${durationFixes.map((f) => `${f.requested}s→${f.resolved}s`).join(", ")}.` : ""}`,
      refs: [input.campaignId, run.id]
    });
  });

  // Regenerated outputs deserve a fresh storage budget: drop stale asset
  // rows so the new generation persists under the same job id.
  if (resetIds.length > 0) {
    const { campaignAssets } = await import("../db/schema");
    const { inArray } = await import("drizzle-orm");
    const { getDb } = await import("../db/client");
    await getDb().delete(campaignAssets).where(inArray(campaignAssets.jobId, resetIds)).catch(() => undefined);
  }

  // Estimate after records exist (async, never blocks submit meaningfully -
  // cached prices; failures just leave the estimate null).
  const stages = normalizeStagePlan(
    campaign.preflight?.plan ?? [],
    normalizeQualityProfile(campaign.request.qualityProfile ?? process.env.LIVEPEER_QUALITY_PROFILE)
  ).filter((s) => wanted.includes(s.id));
  const { total } = await estimateStages(stages).catch(() => ({ total: null, exact: false }));
  if (total !== null) {
    await write((d) => {
      const r = d.campaigns.find((x) => x.id === input.campaignId)?.runs?.find((x) => x.id === run.id);
      if (r) {
        r.estimateUsd = total;
        r.updatedAt = nowIso();
      }
    }).catch(() => undefined);
    run.estimateUsd = total;
  }
  return { run, created: true, workspaceId: input.workspaceId };
}

/* ------------------------- pump (background progress) -------------------- */

const pumpLocks = new Map<string, boolean>();

export interface PumpResult {
  pumped: boolean;
  reason?: string;
}

export interface PumpOptions {
  runId?: string;
  /** Max wall-clock for one pump pass (short for status polls, long detached). */
  budgetMs?: number;
  /**
   * Provider progress-hold seconds per in-flight job. subscribe_progress
   * caps at 25s; the status route uses STATUS_PUMP (short) so a GET never
   * outlives the 15s browser timeout, while detached pumps wait longer.
   */
  progressHoldSeconds?: number;
  /**
   * Status GETs are strictly read/poll-only: allowDispatch false disables
   * new create_media submits (only existing provider ids are polled).
   * Defaults true for detached/produce pumps.
   */
  allowDispatch?: boolean;
  /**
   * Re-fire persist workers for stranded preview jobs. Defaults true;
   * status mode disables it (non-blocking read) and relies on the detached
   * pump the route triggers alongside.
   */
  allowPreviewResume?: boolean;
}

/**
 * Status-route pump budget: 4s wall-clock with 3s progress holds and a
 * shared per-probe deadline (hold + 4s slack), no dispatch, no blocking
 * resume - worst case lands around 11s, inside the 15s UI request timeout
 * (typical path ≈ 3-4s). Detached pumps use longer holds and full dispatch
 * via explicit PumpOptions.
 */
export const STATUS_PUMP: Required<Pick<PumpOptions, "budgetMs" | "progressHoldSeconds">> & {
  allowDispatch: false;
  allowPreviewResume: false;
} = {
  budgetMs: 4000,
  progressHoldSeconds: 3,
  allowDispatch: false,
  allowPreviewResume: false
};

/** Clamp a progress hold to the provider-supported 1-25s window. */
export function resolveProgressHold(value: number | undefined, fallback = 20): number {
  const n = value === undefined ? fallback : value;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(25, Math.max(1, Math.round(n)));
}

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
    const db = await readWorkspace(workspaceId);
    const campaign = db.campaigns.find((c) => c.id === campaignId);
    if (!campaign) return { pumped: progressed, reason: "not-found" };
    if (campaign.preflight?.decision !== "allow") return { pumped: progressed, reason: "blocked" };

    const run = opts.runId
      ? campaign.runs?.find((r) => r.id === opts.runId)
      : [...(campaign.runs ?? [])].reverse().find((r) => r.status === "active");
    if (!run || run.status !== "active") return { pumped: progressed, reason: "no-active-run" };

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
    const sourceMedia = db.sourceMedia.find((m) => m.id === campaign.sourceMediaId);
    // Exact runs bypass stage decisions entirely: owned derivative jobs get
    // one slot each (never first-match-by-stage), and no fail decision for
    // a stage can touch a job outside the exact list.
    const exact = isExactRun(run);
    const decisions = exact ? [] : decideStageRuns(stages, campaign.jobs, sourceMedia?.url, run.stageIds);

    const runJobs = campaign.jobs.filter((j) => runOwnsJob(run, j));
    const inFlight = runJobs.filter((j) => j.status === "generating" && j.livepeerJobId);

    // 1) Poll in-flight provider jobs (parallel network, serialized writes).
    // The hold is explicit per caller: short on the status route (STATUS_PUMP
    // keeps GETs inside the browser timeout), long on detached pumps.
    const holdSeconds = resolveProgressHold(opts.progressHoldSeconds);
    const pollResults = await Promise.allSettled(
      inFlight.map((job) => pollJob(client, workspaceId, campaign, job, holdSeconds))
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
      // Exact fail pass: an owned job whose declared input can never render
      // fails alone with the reason - siblings and the original stay
      // untouched. Still-waiting dependencies stay queued for a later pass.
      const terminalUnready = new Set(["failed", "cancelled", "storage_retry_needed"]);
      const stageOutputs = seedStageOutputs(campaign.jobs);
      for (const job of runJobs) {
        if (job.status !== "queued" && !(job.status === "generating" && !job.outputUrl && !job.livepeerJobId)) continue;
        const stage = stages.find((s) => s.id === job.stageId);
        if (!stage) continue;
        const resolved = resolveStageInput(stage, { sourceMediaUrl: sourceMedia?.url, stageOutputs });
        if (resolved.url) continue;
        const depId = resolved.sourceStageId ?? (stage.inputSource === "stage-output" ? stage.dependsOnStageIds[0] : undefined);
        if (depId) {
          const depJobs = campaign.jobs.filter((j) => j.stageId === depId);
          if (depJobs.length > 0 && !depJobs.some((j) => terminalUnready.has(j.status))) continue;
          const depStage = stages.find((s) => s.id === depId);
          await failStageJobs(
            campaign.id,
            stage.id,
            depStage ? prerequisiteMessage(stage, depStage) : (resolved.reason ?? "Declared input is not ready."),
            workspaceId,
            run.jobIds
          );
        } else {
          await failStageJobs(campaign.id, stage.id, resolved.reason ?? "Declared input is not ready.", workspaceId, run.jobIds);
        }
      }
    }
    const slots = allowDispatch
      ? exact
        ? selectExactSlots(stages, runJobs, campaign.jobs, sourceMedia?.url, activeCount, ceiling)
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

/** Provider probe without state: progress hold first, status endpoint fallback. No DB. */
export async function pollProviderJob(
  client: LivepeerMcpClient,
  providerJobId: string,
  holdSeconds: number
): Promise<import("./mcp-client").MediaStatusResult> {
  // Shared deadline for both attempts: even a hung provider connection
  // cannot outlive hold + slack, so status pumps stay inside their budget.
  const hold = resolveProgressHold(holdSeconds);
  const deadline = Date.now() + hold * 1000 + 4000;
  const remaining = (): number => Math.max(0, deadline - Date.now());
  try {
    return await withTimeout(client.waitForProgress(providerJobId, hold), remaining());
  } catch {
    return withTimeout(client.getMediaStatus(providerJobId), remaining());
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("probe timeout")), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
/** Poll one in-flight job: progress call first, status endpoint fallback. Returns true on state change. */
async function pollJob(
  client: LivepeerMcpClient,
  workspaceId: string,
  campaign: Campaign,
  job: ProductionJob,
  holdSeconds: number
): Promise<boolean> {
  if (!job.livepeerJobId) return false;
  let status;
  try {
    status = await pollProviderJob(client, job.livepeerJobId, holdSeconds);
  } catch {
    return false; // transient probe failure - next pump retries, nothing lost
  }
  // Preservation-owned provider job: the handle was persisted by
  // trackPreservationJob, so this poll attributes to the preservation tool
  // (never to a create_media render that never happened).
  const pendingTool =
    job.requestMeta?.preservationPendingTool === "place_subject" ||
    job.requestMeta?.preservationPendingTool === "create_variations"
      ? job.requestMeta.preservationPendingTool
      : undefined;
  if (status.terminal && status.outputUrl && isUsableOutputUrl(status.outputUrl)) {
    await finalizeDispatchedJob(workspaceId, campaign, job, {
      providerUrl: status.outputUrl,
      livepeerJobId: status.jobId ?? job.livepeerJobId,
      costUsd: status.costUsd,
      capability: status.capability,
      ...(pendingTool
        ? {
            modelNote: pendingTool === "place_subject" ? "place_subject operation succeeded" : "create_variations (explicit refinement)",
            preservation: {
              actualCapability: pendingTool,
              // A tracked variation derives from the selected output:
              // provenance, never a preservation claim.
              evidenceLevel: pendingTool === "place_subject" ? ("subject-preserving" as const) : ("none" as const),
              providerOperationSucceeded: true
            }
          }
        : {
            // No preservation handle was ever pending, so this poll
            // delivered a standard guided render - correct the claim-time
            // intent stamp (which names the resolved tool) to what actually
            // rendered. Any recorded fallback reason survives the merge.
            preservation: {
              actualCapability: "create_media" as const,
              evidenceLevel: "source-guided" as const,
              providerOperationSucceeded: true
            }
          })
    });
    return true;
  }
  if (status.terminal && !status.outputUrl) {
    if (pendingTool) {
      // Confirmed terminal preservation failure: exhaust the tool and
      // re-queue for exactly one guided render. The dead handle is gone,
      // so this is the only fallback - never a second preservation call.
      await failPreservationTool(
        workspaceId,
        campaign.id,
        job.id,
        pendingTool,
        `Preservation job ended (${status.status}) without an output - rendered as a guided output instead.`
      );
      return true;
    }
    await withCampaignLock(campaign.id, () =>
      writeWorkspace(workspaceId, (d) => {
        const j = d.campaigns.find((x) => x.id === campaign.id)?.jobs.find((x) => x.id === job.id);
        if (j && j.status === "generating") {
          j.status = "failed";
          j.error = `Livepeer job ended (${status.status}) without an output.`;
          j.finishedAt = nowIso();
        }
      })
    );
    return true;
  }
  return false;
}

export interface DispatchInput {
  providerUrl?: string;
  livepeerJobId?: string;
  costUsd?: number;
  capability?: string;
  modelNote?: string;
}

/** Record a provider output as preview, persist detached, critique advisory. */
async function finalizeDispatchedJob(
  workspaceId: string,
  campaign: Campaign,
  job: ProductionJob,
  result: DispatchInput & { providerUrl: string; preservation?: PreservationOutcome }
): Promise<void> {
  await withCampaignLock(campaign.id, () =>
    writeWorkspace(workspaceId, (d) => {
      const j = d.campaigns.find((x) => x.id === campaign.id)?.jobs.find((x) => x.id === job.id);
      if (!j) return;
      // Structured actual capability: provider report wins, else the
      // dispatched value. job.capability stays the planned value - it is
      // never overwritten with display text.
      const actual = result.capability ?? j.actualCapability ?? j.capability;
      Object.assign(j, finalizedPreviewFields(result));
      j.actualCapability = actual;
      if (result.preservation) {
        j.requestMeta = {
          ...j.requestMeta,
          preservationActualCapability: result.preservation.actualCapability,
          preservationEvidenceLevel: result.preservation.evidenceLevel,
          providerOperationSucceeded: result.preservation.providerOperationSucceeded,
          ...(result.preservation.fallbackReason ? { fallbackReason: result.preservation.fallbackReason } : {})
        };
        // A resolved preservation outcome retires its async handle: the
        // provider job delivered, so nothing remains pending.
        delete j.requestMeta.preservationPendingTool;
      }
    })
  );
  void persistPreviewInBackground({
    workspaceId,
    campaignId: campaign.id,
    jobId: job.id,
    providerUrl: result.providerUrl,
    promptHash: sha256(job.prompt),
    providerModel: result.capability ?? job.capability,
    livepeerJobId: result.livepeerJobId ?? job.livepeerJobId,
    costUsd: result.costUsd ?? job.costUsd,
    kind: job.kind
  }).catch(() => undefined);
  // Advisory vision check for image outputs (never fails the stage).
  if (qualityCheckEnabled() && job.kind !== "image-to-video") {
    const db = await readWorkspace(workspaceId).catch(() => null);
    const sourceUrl = db?.sourceMedia.find((m) => m.id === campaign.sourceMediaId)?.url;
    if (sourceUrl) {
      try {
        const client = new LivepeerMcpClient(livepeerConfig());
        const critique = await client.critiqueShot({
          generatedUrl: result.providerUrl,
          referenceUrl: sourceUrl,
          entityName: `${campaign.brand} ${campaign.productName}`.slice(0, 80)
        });
        await withCampaignLock(campaign.id, () =>
          writeWorkspace(workspaceId, (d) => {
            const j = d.campaigns.find((x) => x.id === campaign.id)?.jobs.find((x) => x.id === job.id);
            if (j) {
              if (critique.score !== null) j.qualityScore = critique.score;
              j.qualityPassed = critique.passed;
              j.qualityNote = critique.note.slice(0, 300);
            }
          })
        ).catch(() => undefined);
      } catch {
        // Critique is advisory - its failure is recorded nowhere billable.
      }
    }
  }
}

function jobIdempotencyKey(campaignId: string, job: ProductionJob): string {
  return `pf_${campaignId}_${job.stageId}_${job.id}`;
}

/**
 * Build the preservation policy input for one dispatch slot (pure).
 * Ownership is verified against durable records, never trusted from the
 * slot: approved-source inputs must match the campaign's registered source
 * row byte-for-byte, stage outputs must belong to a job in this campaign,
 * and variation sources must be a completed output of this campaign (else
 * the variation request is dropped before the policy sees it).
 */
export function preservationContextFor(
  campaign: Campaign,
  sourceMedia: Array<{ id: string; url: string }>,
  stage: ProductionStagePlan,
  job: ProductionJob,
  slot: { inputUrl: string; resolvedInputSource: StageInputSource; sourceStageId?: string }
): {
  ctx: {
    stageId: string;
    kind: ProductionStagePlan["kind"];
    role: ProductionStagePlan["role"];
    sourceUrl?: string;
    sourceAssetId?: string;
    sourceStageId?: string;
    sourceOwnedByCampaign: boolean;
    rightsAllowed: boolean;
    variationExplicit: boolean;
    variationSourceUrl?: string;
    placeSubjectMode: "auto" | "off";
  };
  sourceAssetId?: string;
} {
  const sourceRow = sourceMedia.find((m) => m.id === campaign.sourceMediaId);
  const owned = ownsDispatchSource(campaign, slot, sourceRow?.url);
  const approvedSource = slot.resolvedInputSource === "approved-source" && !!sourceRow && sourceRow.url === slot.inputUrl;
  const variationOwned =
    job.variationExplicit === true &&
    typeof job.variationSourceUrl === "string" &&
    campaign.jobs.some((j) => j.providerOutputUrl === job.variationSourceUrl || j.outputUrl === job.variationSourceUrl);
  return {
    ctx: {
      stageId: stage.id,
      kind: stage.kind,
      role: job.role ?? stage.role,
      sourceUrl: slot.inputUrl,
      ...(approvedSource ? { sourceAssetId: campaign.sourceMediaId } : {}),
      ...(slot.sourceStageId ? { sourceStageId: slot.sourceStageId } : {}),
      sourceOwnedByCampaign: owned,
      rightsAllowed: campaign.preflight?.decision === "allow",
      variationExplicit: job.variationExplicit === true,
      ...(variationOwned && job.variationSourceUrl ? { variationSourceUrl: job.variationSourceUrl } : {}),
      placeSubjectMode: placeSubjectMode()
    },
    ...(approvedSource ? { sourceAssetId: campaign.sourceMediaId } : {})
  };
}

/** Durable-record ownership check for the resolved dispatch input. */
function ownsDispatchSource(
  campaign: Campaign,
  slot: { inputUrl: string; resolvedInputSource: StageInputSource; sourceStageId?: string },
  sourceRowUrl?: string
): boolean {
  if (slot.resolvedInputSource === "stage-output") {
    if (!slot.sourceStageId) return false;
    return campaign.jobs.some(
      (j) => j.stageId === slot.sourceStageId && (j.providerOutputUrl === slot.inputUrl || j.outputUrl === slot.inputUrl)
    );
  }
  if (slot.resolvedInputSource === "approved-source") {
    // Initial production has no prior outputs: ownership is the registered
    // source row matching byte-for-byte, never a bare URL assertion.
    return !!sourceRowUrl && sourceRowUrl === slot.inputUrl;
  }
  // canonical-anchor: the URL must be a recorded output of this campaign.
  return campaign.jobs.some((j) => j.providerOutputUrl === slot.inputUrl || j.outputUrl === slot.inputUrl);
}

/** Record a failed preservation attempt durably before any fallback. */
async function recordPreservationFallback(
  workspaceId: string,
  campaignId: string,
  jobId: string,
  reason: string
): Promise<void> {
  await withCampaignLock(campaignId, () =>
    writeWorkspace(workspaceId, (d) => {
      const j = d.campaigns.find((x) => x.id === campaignId)?.jobs.find((x) => x.id === jobId);
      if (j) {
        j.requestMeta = {
          ...j.requestMeta,
          fallbackReason: reason.slice(0, 400),
          preservationActualCapability: "create_media",
          providerOperationSucceeded: false
        };
      }
    })
  );
}

/**
 * Persist an async preservation handle: the provider accepted the
 * preservation job and will deliver later. The PermitFrame job keeps its
 * generating status with the provider id, and the pending-tool marker
 * routes all later polling/finalization through the preservation outcome.
 * Returns after persisting - the pump polls on later passes; no
 * create_media fallback runs while the handle is pending.
 */
async function trackPreservationJob(
  workspaceId: string,
  campaignId: string,
  jobId: string,
  tool: "place_subject" | "create_variations",
  providerJobId: string
): Promise<void> {
  await withCampaignLock(campaignId, () =>
    writeWorkspace(workspaceId, (d) => {
      const j = d.campaigns.find((x) => x.id === campaignId)?.jobs.find((x) => x.id === jobId);
      if (j && j.status === "generating") {
        j.livepeerJobId = providerJobId;
        j.dispatchedAt = nowIso();
        j.requestMeta = { ...j.requestMeta, preservationPendingTool: tool };
      }
    })
  );
}

/**
 * Exhaust a preservation tool after its async handle died terminally with
 * no output: record the failure, re-queue the job for exactly one guided
 * render, and never retry the rejected tool for this job. Re-queueing
 * keeps the SAME job id (and the guided render reuses its stable key),
 * so no duplicate paid preservation job can follow.
 */
async function failPreservationTool(
  workspaceId: string,
  campaignId: string,
  jobId: string,
  tool: "place_subject" | "create_variations",
  reason: string
): Promise<void> {
  await withCampaignLock(campaignId, () =>
    writeWorkspace(workspaceId, (d) => {
      const j = d.campaigns.find((x) => x.id === campaignId)?.jobs.find((x) => x.id === jobId);
      if (!j) return;
      const failed = new Set(j.requestMeta?.preservationFailedTools ?? []);
      failed.add(tool);
      j.requestMeta = {
        ...j.requestMeta,
        fallbackReason: reason.slice(0, 400),
        preservationActualCapability: "create_media",
        preservationFailedTools: [...failed],
        providerOperationSucceeded: false
      };
      delete j.requestMeta?.preservationPendingTool;
      // Back to the dispatch queue for the single guided fallback: the
      // provider handle is dead, so nothing is polled and nothing double-
      // spends. Attempts are untouched (this was one logical attempt).
      if (j.status === "generating" || j.status === "queued") {
        j.status = "queued";
        j.livepeerJobId = undefined;
        j.dispatchedAt = undefined;
      }
    })
  );
}

/**
 * Exact input provenance written onto a job at dispatch: what the plan
 * declared, what actually fed the run, and which dependency supplied it.
 * Pure so the recovery test asserts the real mapping.
 */
export function provenanceMeta(
  stage: ProductionStagePlan,
  slot: { resolvedInputSource: StageInputSource; sourceStageId?: string },
  preservation?: PreservationDecision
): NonNullable<ProductionJob["requestMeta"]> {
  return {
    sourceKind: slot.sourceStageId ? "prior-output" : "source-media",
    inputSource: stage.inputSource,
    resolvedInputSource: slot.resolvedInputSource,
    ...(slot.sourceStageId ? { sourceStageId: slot.sourceStageId } : {}),
    qualityProfile: stage.qualityProfile,
    role: stage.role,
    ...(stage.fallbackFrom ? { fallbackFrom: stage.fallbackFrom } : {}),
    ...(preservation
      ? {
          preservationRequested: preservation.requested,
          preservationResolved: preservation.resolved,
          preservationEvidenceLevel: preservation.evidenceLevel,
          preservationRequestedCapability: preservation.requestedCapability,
          preservationActualCapability: preservation.actualCapability,
          ...(preservation.approvedSourceAssetId ? { approvedSourceAssetId: preservation.approvedSourceAssetId } : {}),
          ...(preservation.fallbackReason ? { fallbackReason: preservation.fallbackReason } : {})
        }
      : {})
  };
}

/**
 * Preservation outcome recorded when a provider output lands: which tool
 * actually rendered it, what evidence level that earns, and whether the
 * operation succeeded. Finalize writes exactly this - success is observed
 * (a usable output URL), never assumed.
 */
export interface PreservationOutcome {
  actualCapability: PreservationCapability;
  evidenceLevel: PreservationEvidenceLevel;
  providerOperationSucceeded: boolean;
  fallbackReason?: string;
}

/**
 * Field patch applied when a provider output lands (preview_ready).
 * Pure - finalizeDispatchedJob persists exactly this. Note: capability is
 * deliberately NOT patched - job.capability stays the planned value and
 * job.actualCapability tracks what rendered.
 */
export function finalizedPreviewFields(
  result: { providerUrl: string; livepeerJobId?: string; costUsd?: number; modelNote?: string }
): Partial<
  Pick<
    ProductionJob,
    "status" | "providerOutputUrl" | "outputUrl" | "providerUrlFingerprint" | "livepeerJobId" | "costUsd" | "modelNote"
  >
> {
  return {
    status: "preview_ready",
    providerOutputUrl: result.providerUrl,
    outputUrl: result.providerUrl,
    providerUrlFingerprint: sha256(result.providerUrl),
    ...(result.livepeerJobId ? { livepeerJobId: result.livepeerJobId } : {}),
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
    ...(result.modelNote ? { modelNote: result.modelNote.slice(0, 400) } : {})
  };
}

/**
 * Dispatch one runnable slot. Async submit persists the provider id
 * immediately; timeouts without an id retry later under the SAME
 * idempotency key (provider dedupes - no duplicate paid jobs).
 */
async function dispatchSlot(
  client: LivepeerMcpClient,
  workspaceId: string,
  campaign: Campaign,
  run: ProductionRun,
  slot: { job: ProductionJob; inputUrl: string; resolvedInputSource: StageInputSource; sourceStageId?: string },
  spentUsd: number
): Promise<boolean> {
  const db = await readWorkspace(workspaceId);
  const fresh = db.campaigns.find((c) => c.id === campaign.id);
  const stage = fresh?.preflight?.plan.find((s) => s.id === slot.job.stageId);
  const job = fresh?.jobs.find((j) => j.id === slot.job.id);
  if (!fresh || !stage || !job) return false;
  if (job.status !== "queued" && !(job.status === "generating" && !job.outputUrl && !job.livepeerJobId)) {
    return false; // claimed by a concurrent pump - serialized writes decide
  }
  const isVideo = job.kind === "image-to-video";
  // Machine capability for pricing/dispatch/resolution: the structured
  // actual value, falling back to the planned one. Never display text.
  const dispatchCap = job.actualCapability ?? job.capability;
  // Final server-side re-resolution: policy may have shifted since submit.
  // Rejections fail the stage; adjustments dispatch resolved and persist it.
  const requestedSeconds = stage.requestedDurationSeconds ?? stage.durationSeconds ?? 5;
  let durationSeconds = stage.durationSeconds ?? (isVideo ? 5 : 0);
  if (isVideo) {
    const re = resolveMotionDuration(requestedSeconds, dispatchCap);
    if (!re.ok) {
      await failStageJobs(campaign.id, stage.id, `"${stage.label}": ${re.error}`, workspaceId, run.jobIds);
      return true;
    }
    durationSeconds = re.resolvedSeconds;
    // Persist unconditionally: seeded/manual rows may lack duration fields,
    // and uniformity keeps receipts truthful without special cases.
    await withCampaignLock(campaign.id, () =>
      writeWorkspace(workspaceId, (d) => {
        const c = d.campaigns.find((x) => x.id === campaign.id);
        const st = c?.preflight?.plan.find((s) => s.id === stage.id);
        if (st) {
          st.durationSeconds = re.resolvedSeconds;
          st.requestedDurationSeconds = re.requestedSeconds;
          if (re.adjustmentReason) st.durationNote = re.adjustmentReason;
          st.durationSource = re.source;
        }
        const j = c?.jobs.find((x) => x.id === job.id);
        if (j) {
          j.requestMeta = {
            ...j.requestMeta,
            durationSeconds: re.resolvedSeconds,
            requestedDurationSeconds: re.requestedSeconds,
            ...(re.adjustmentReason ? { durationNote: re.adjustmentReason } : {}),
            durationSource: re.source
          };
        }
      })
    );
  }
  const live = await fetchLivePriceMap();
  const quote = quoteStage({ capability: dispatchCap, kind: job.kind }, live, durationSeconds);
  const capGate = shouldDispatchUnderCap(spentUsd, quote ? quote.usd : null, run.spendCapUsd ?? campaign.request.productionSpec?.maxSpendCapUsd);
  if (!capGate.ok) {
    await failStageJobs(campaign.id, stage.id, capGate.reason ?? "Spend cap reached.", workspaceId, run.jobIds);
    return true;
  }
  try {
    await assertCapabilityAvailable(dispatchCap);
  } catch (error) {
    await failStageJobs(campaign.id, stage.id, (error as Error).message, workspaceId, run.jobIds);
    return true;
  }

  // Preservation policy: strongest honest path for this stage, validated
  // before any paid dispatch. Refusals fail the stage with the reason and
  // spend nothing - no silent fallback to an arbitrary render.
  const { ctx: preservationCtx } = preservationContextFor(fresh, db.sourceMedia, stage, job, slot);
  const preservation = resolvePreservation(preservationCtx);
  if (preservation.refusal) {
    await failStageJobs(campaign.id, stage.id, `"${stage.label}": ${preservation.refusal}`, workspaceId, run.jobIds);
    return true;
  }

  const base = {
    capability: dispatchCap,
    kind: job.kind,
    prompt: job.prompt,
    sourceUrl: slot.inputUrl,
    maxCostUsd: stageSpendingCeiling({ capability: dispatchCap, kind: job.kind }, live, durationSeconds),
    inputs: { aspect_ratio: stage.format, ...(isVideo ? { duration: durationSeconds } : {}) },
    qualityProfile: stage.qualityProfile,
    sessionId: campaign.id,
    idempotencyKey: jobIdempotencyKey(campaign.id, job)
  };

  // Mark generating + provenance first (compare-and-set inside the lock -
  // a concurrent pump that already claimed this job loses harmlessly).
  let claimed = false;
  await withCampaignLock(campaign.id, () =>
    writeWorkspace(workspaceId, (d) => {
      const c = d.campaigns.find((x) => x.id === campaign.id);
      const j = c?.jobs.find((x) => x.id === job.id);
      if (!c || !j) return;
      if (j.status !== "queued" && !(j.status === "generating" && !j.outputUrl && !j.livepeerJobId)) return;
      c.status = "generating";
      j.status = "generating";
      j.startedAt = nowIso();
      j.runId = run.id;
      j.attempts = (j.attempts ?? 0) + 1;
      j.lastAttemptAt = nowIso();
      // A fresh attempt clears any prior backoff; failures re-arm it below.
      j.nextAttemptAt = undefined;
      j.lastTransientError = undefined;
      j.requestMeta = {
        ...j.requestMeta,
        ...provenanceMeta(
          stage,
          {
            resolvedInputSource: slot.resolvedInputSource,
            ...(slot.sourceStageId ? { sourceStageId: slot.sourceStageId } : {})
          },
          preservation
        )
      };
      if (!j.requestedCapability) j.requestedCapability = stage.capability;
      if (!j.qualityProfile) j.qualityProfile = stage.qualityProfile;
      if (!j.role) j.role = stage.role;
      // Structured actual capability: what this dispatch sends. The planned
      // value in j.capability is never overwritten with display text.
      j.actualCapability = j.capability;
      claimed = true;
    })
  );
  if (!claimed) return false;

  // place_subject only when the policy resolved subject-placement for an
  // eligible image stage with a verified source - and never after the tool
  // failed terminally for this job (exhausted tools stay exhausted: a
  // rejected preservation op must not become a second paid provider job).
  // The response classifies three ways: inline output finalizes; a valid
  // async handle is persisted and polled (no fallback while pending); only
  // a malformed/handle-less response falls back to guided create_media.
  if (
    preservation.resolved === "subject-placement" &&
    !(job.requestMeta?.preservationFailedTools ?? []).includes("place_subject")
  ) {
    // Stale marker with no provider id (e.g. reset cleared the handle):
    // drop it so this attempt is judged on its own response.
    if (job.requestMeta?.preservationPendingTool && !job.livepeerJobId) {
      const stale = job.requestMeta.preservationPendingTool;
      await withCampaignLock(campaign.id, () =>
        writeWorkspace(workspaceId, (d) => {
          const j = d.campaigns.find((x) => x.id === campaign.id)?.jobs.find((x) => x.id === job.id);
          if (j?.requestMeta?.preservationPendingTool === stale && !j.livepeerJobId) {
            delete j.requestMeta.preservationPendingTool;
          }
        })
      );
    }
    let placeOutcome: PreservationCallOutcome;
    let placeCostUsd: number | undefined;
    let placeCapability: string | undefined;
    try {
      const placed = await client.placeSubject({
        sourceUrl: slot.inputUrl,
        scenes: [job.prompt],
        maxCostUsd: base.maxCostUsd,
        sessionId: campaign.id,
        idempotencyKey: preservationOperationKey(jobIdempotencyKey(campaign.id, job), "place")
      });
      placeOutcome = classifyPreservationResult(placed?.outputUrls, placed?.jobId);
      placeCostUsd = placed?.costUsd;
      placeCapability = placed?.capability;
    } catch (error) {
      placeOutcome = { kind: "empty", reason: `place_subject call failed: ${(error as Error).message.slice(0, 200)}` };
    }
    if (placeOutcome.kind === "inline") {
      await finalizeDispatchedJob(workspaceId, campaign, job, {
        providerUrl: placeOutcome.url,
        ...(placeCostUsd !== undefined ? { costUsd: placeCostUsd } : {}),
        ...(placeCapability ? { capability: placeCapability } : {}),
        modelNote: "place_subject operation succeeded",
        preservation: {
          actualCapability: "place_subject",
          evidenceLevel: "subject-preserving",
          providerOperationSucceeded: true
        }
      });
      return true;
    }
    if (placeOutcome.kind === "track") {
      // Async handle: persist the provider id on this job and stop. The
      // poll path owns it from here; create_media must not run while the
      // preservation job is pending (selectors skip generating jobs that
      // hold a provider id).
      await trackPreservationJob(workspaceId, campaign.id, job.id, "place_subject", placeOutcome.jobId);
      return true;
    }
    await recordPreservationFallback(
      workspaceId,
      campaign.id,
      job.id,
      `Subject placement failed (${placeOutcome.reason}) - falling back to guided generation.`
    );
    if (!preservation.allowFallbackToSourceGuided) {
      await failStageJobs(campaign.id, stage.id, `"${stage.label}": subject placement failed and fallback is not permitted (${placeOutcome.reason}).`, workspaceId, run.jobIds);
      return true;
    }
  }

  // create_variations only for explicit refinements carrying a selected
  // completed output (revise / variations actions). Initial production jobs
  // never set variationExplicit, so automatic variation is impossible here
  // even if a stale variationSourceUrl lingers on the record. Like
  // place_subject above: inline finalizes, async handles track-and-poll,
  // and only handle-less responses fall back to guided generation.
  let variationFallbackReason: string | undefined;
  if (
    preservation.resolved === "variation" &&
    !(job.requestMeta?.preservationFailedTools ?? []).includes("create_variations")
  ) {
    if (job.requestMeta?.preservationPendingTool && !job.livepeerJobId) {
      const stale = job.requestMeta.preservationPendingTool;
      await withCampaignLock(campaign.id, () =>
        writeWorkspace(workspaceId, (d) => {
          const j = d.campaigns.find((x) => x.id === campaign.id)?.jobs.find((x) => x.id === job.id);
          if (j?.requestMeta?.preservationPendingTool === stale && !j.livepeerJobId) {
            delete j.requestMeta.preservationPendingTool;
          }
        })
      );
    }
    let varyOutcome: PreservationCallOutcome;
    let variedCostUsd: number | undefined;
    let variedCapability: string | undefined;
    try {
      const varied = await client.createVariations({
        sourceUrl: job.variationSourceUrl as string,
        prompt: job.prompt,
        mode: "prompt",
        count: 1,
        maxCostUsd: base.maxCostUsd,
        sessionId: campaign.id,
        idempotencyKey: preservationOperationKey(jobIdempotencyKey(campaign.id, job), "vary")
      });
      varyOutcome = classifyPreservationResult(varied?.outputUrls, varied?.jobId);
      variedCostUsd = varied?.costUsd;
      variedCapability = varied?.capability;
    } catch (error) {
      varyOutcome = { kind: "empty", reason: `create_variations call failed (${(error as Error).message.slice(0, 200)})` };
    }
    if (varyOutcome.kind === "inline") {
      await finalizeDispatchedJob(workspaceId, campaign, job, {
        providerUrl: varyOutcome.url,
        ...(variedCostUsd !== undefined ? { costUsd: variedCostUsd } : {}),
        ...(variedCapability ? { capability: variedCapability } : {}),
        modelNote: "create_variations (explicit refinement)",
        preservation: {
          actualCapability: "create_variations",
          // A variation derives from a selected output, not the approved
          // source: provenance, never a preservation claim.
          evidenceLevel: "none",
          providerOperationSucceeded: true
        }
      });
      return true;
    }
    if (varyOutcome.kind === "track") {
      await trackPreservationJob(workspaceId, campaign.id, job.id, "create_variations", varyOutcome.jobId);
      return true;
    }
    variationFallbackReason = `${varyOutcome.reason} - rendered as a guided output instead.`;
    await recordPreservationFallback(workspaceId, campaign.id, job.id, variationFallbackReason);
    if (!preservation.allowFallbackToSourceGuided) {
      await failStageJobs(campaign.id, stage.id, `"${stage.label}": ${variationFallbackReason}`, workspaceId, run.jobIds);
      return true;
    }
  }

  // Standard path: async submit (id persisted immediately), poll later.
  // Timeouts without an id retry under the SAME key - provider dedupes.
  // Transient failures arm a persisted backoff (resumable, no busy loop);
  // terminal rejections and exhausted attempts fail only this stage.
  let submitted;
  try {
    submitted = await client.submitMedia(base);
  } catch (error) {
    const replacement = (error as Error).message.match(/recommended replacement is ([a-z0-9-]+)/i);
    if (!replacement) {
      await recordDispatchFailure(workspaceId, campaign, job, stage, error);
      return true;
    }
    // The replacement model gets its own duration resolution + pricing:
    // different buckets or limits may apply. Rejections fail honestly;
    // the retry keeps the requested length, never the old numbers.
    const replacementCap = replacement[1];
    let replacementInput = { ...base, capability: replacementCap };
    if (isVideo) {
      const re = resolveMotionDuration(requestedSeconds, replacementCap);
      if (!re.ok) {
        await failStageJobs(
          campaign.id,
          stage.id,
          `"${stage.label}": replacement model ${replacementCap} rejected the length - ${re.error}`,
          workspaceId,
          run.jobIds
        );
        return true;
      }
      const reQuote = quoteStage({ capability: replacementCap, kind: job.kind }, live, re.resolvedSeconds);
      const reCeiling = stageSpendingCeiling({ capability: replacementCap, kind: job.kind }, live, re.resolvedSeconds);
      // The replacement may price differently - re-check the run cap before spending.
      const reCapGate = shouldDispatchUnderCap(
        spentUsd,
        reQuote ? reQuote.usd : null,
        run.spendCapUsd ?? campaign.request.productionSpec?.maxSpendCapUsd
      );
      if (!reCapGate.ok) {
        await failStageJobs(campaign.id, stage.id, reCapGate.reason ?? "Spend cap reached.", workspaceId, run.jobIds);
        return true;
      }
      replacementInput = {
        ...replacementInput,
        maxCostUsd: reCeiling,
        inputs: { aspect_ratio: stage.format, duration: re.resolvedSeconds }
      };
      await withCampaignLock(campaign.id, () =>
        writeWorkspace(workspaceId, (d) => {
          const c = d.campaigns.find((x) => x.id === campaign.id);
          const st = c?.preflight?.plan.find((s) => s.id === stage.id);
          if (st) {
            st.durationSeconds = re.resolvedSeconds;
            st.requestedDurationSeconds = re.requestedSeconds;
            if (re.adjustmentReason) st.durationNote = re.adjustmentReason;
            st.durationSource = re.source;
          }
          const j = c?.jobs.find((x) => x.id === job.id);
          if (j?.requestMeta) {
            j.requestMeta.durationSeconds = re.resolvedSeconds;
            j.requestMeta.requestedDurationSeconds = re.requestedSeconds;
            if (re.adjustmentReason) j.requestMeta.durationNote = re.adjustmentReason;
            j.requestMeta.durationSource = re.source;
          }
        })
      );
    }
    try {
      submitted = await client.submitMedia(replacementInput);
    } catch (second) {
      await recordDispatchFailure(workspaceId, campaign, job, stage, second);
      return true;
    }
    await withCampaignLock(campaign.id, () =>
      writeWorkspace(workspaceId, (d) => {
        const j = d.campaigns.find((x) => x.id === campaign.id)?.jobs.find((x) => x.id === job.id);
        // Structured substitution: planned capability untouched, actual
        // tracks the replacement. UI derives its friendly label from these
        // fields - never from formatted text.
        if (j) j.actualCapability = replacementCap;
      })
    );
  }
  const outcome = classifySubmitResult(submitted);
  if (outcome.action === "finalize") {
    // Standard create_media render: source-guided when the policy resolved
    // guided generation (or fell back to it); otherwise no preservation
    // claim beyond the recorded fallback reason.
    const guided = preservation.resolved === "source-guided-generation";
    await finalizeDispatchedJob(workspaceId, campaign, job, {
      providerUrl: outcome.providerUrl,
      costUsd: outcome.costUsd,
      capability: outcome.capability,
      preservation: {
        actualCapability: "create_media",
        evidenceLevel: guided ? "source-guided" : "none",
        providerOperationSucceeded: true,
        ...(preservation.fallbackReason || variationFallbackReason
          ? { fallbackReason: [preservation.fallbackReason, variationFallbackReason].filter(Boolean).join(" ") }
          : {})
      }
    });
    return true;
  }
  if (outcome.action === "fail") {
    await failStageJobs(campaign.id, stage.id, outcome.reason, workspaceId, run.jobIds);
    return true;
  }
  await withCampaignLock(campaign.id, () =>
    writeWorkspace(workspaceId, (d) => {
      const j = d.campaigns.find((x) => x.id === campaign.id)?.jobs.find((x) => x.id === job.id);
      if (j && j.status === "generating" && outcome.action === "track") {
        j.livepeerJobId = outcome.jobId;
        j.dispatchedAt = nowIso();
      }
    })
  );
  return true;
}

/**
 * Record a submit failure durably: terminal rejections and exhausted
 * attempts fail the stage with the honest provider reason (siblings
 * continue); transient failures keep the job resumable with exponential
 * backoff and a redacted note. Same idempotency key on every retry.
 */
async function recordDispatchFailure(
  workspaceId: string,
  campaign: Campaign,
  job: ProductionJob,
  stage: { id: string },
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : "Submit failed.";
  const kind = classifySubmitError(message);
  const now = nowIso();
  let exhausted = false;
  await withCampaignLock(campaign.id, () =>
    writeWorkspace(workspaceId, (d) => {
      const j = d.campaigns.find((x) => x.id === campaign.id)?.jobs.find((x) => x.id === job.id);
      if (!j || (j.status !== "generating" && j.status !== "queued")) return;
      const attempts = j.attempts ?? 1;
      j.lastAttemptAt = now;
      j.lastTransientError = redactSubmitError(message);
      if (kind === "terminal" || attempts >= maxDispatchAttempts()) {
        exhausted = true;
        return;
      }
      j.nextAttemptAt = new Date(Date.now() + computeBackoffMs(attempts)).toISOString();
    })
  );
  if (!exhausted) return;
  const reason =
    kind === "terminal"
      ? `Livepeer refused this stage: ${redactSubmitError(message)}`
      : `Livepeer submit failed ${maxDispatchAttempts()} times: ${redactSubmitError(message)}`;
  await withCampaignLock(campaign.id, () =>
    writeWorkspace(workspaceId, (d) => {
      const c = d.campaigns.find((x) => x.id === campaign.id);
      const j = c?.jobs.find((x) => x.id === job.id);
      if (c) c.status = "review";
      if (j && (j.status === "generating" || j.status === "queued")) {
        j.status = "failed";
        j.error = reason.slice(0, 400);
        j.finishedAt = nowIso();
      }
    })
  );
}

async function failRunStages(
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
async function completeRun(workspaceId: string, campaignId: string, runId: string): Promise<void> {
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// generate_project / submit_creative_job were evaluated read-only against
// tools/list: they render multi-scene narratives into one viewer URL with
// auto-planning and checkpoints. That shape does NOT fit template packs -
// independent per-format deliverables with per-stage receipts, explicit DAG
// edges, and per-stage spend provenance. Forcing packs through a narrative
// job would break the independence rule and per-stage evidence, so dispatch
// stays on create_media (+place_subject / create_variations where the
// single-output schema fits) until a narrative product needs them.

export interface RunStatusSnapshot {
  run: ProductionRun;
  stages: { stageId: string; label: string; status: string; costUsd: number | null; estimateUsd: number | null; pricedCapability: string | null }[];
  jobs: { id: string; stageId: string; status: string; outputUrl: string | null; costUsd: number | null; error: string | null }[];
  progress: { ready: number; total: number };
  estimateTotal: number | null;
  actualTotal: number;
  spendCapUsd?: number;
}

/**
 * Status-route logic, extracted for testability: read/poll-only short pump
 * first (returns fast), full detached pump alongside (not awaited), ledger
 * on cached prices only. The route itself only handles auth/HTTP.
 */
export async function getRunStatusSnapshot(
  workspaceId: string,
  campaignId: string,
  runId: string
): Promise<RunStatusSnapshot | null> {
  // Read/poll-only first (returns fast), then full progress detached (not
  // awaited) - this order matters: the per-campaign pump lock would
  // otherwise collapse the short poll into the long pump and the GET would
  // carry no fresh progress.
  await pumpRun(workspaceId, campaignId, { runId, ...STATUS_PUMP }).catch(() => undefined);
  void pumpRun(workspaceId, campaignId, { runId, budgetMs: 8 * 60 * 1000 }).catch(() => undefined);
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
