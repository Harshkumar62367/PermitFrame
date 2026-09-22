import type { Database, ProductionJob, ProductionRun, ProductionStagePlan } from "../types";
import { newId, nowIso, updateDb } from "../store";
import { readWorkspace, writeWorkspace } from "./run-store";
import { checkAssetsPerRun, checkProfileAccess, resolveEntitlements } from "../entitlements";
import { normalizeQualityProfile, normalizeStagePlan } from "./plan-dag";
import { createJobRecords } from "./pipeline";
import { fetchLivePriceMap, quoteStage } from "./pricing";
import { resolveMotionDuration } from "./duration-policy";
import { findActiveRun } from "./run-scope";
import { resolveMaxConcurrency } from "./run-retry";

/**
 * Run submission (fast, synchronous part): validate, create durable job
 * records, persist the run, and return immediately. Never dispatches - the
 * pump does that. Depends on scope (dedupe), tuning (ceilings), and leaf
 * policy modules only.
 */

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
