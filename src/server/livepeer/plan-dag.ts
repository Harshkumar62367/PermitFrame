import type {
  ProductionJob,
  ProductionStagePlan,
  QualityProfile,
  StageInputSource,
  StageRole
} from "../types";

/**
 * Explicit production DAG. Replaces the old linear "previous output feeds
 * the next stage" chain, which silently made independent format outputs
 * depend on one another (1:1 derived from 9:16, 16:9 from 1:1) and let
 * product/creator drift accumulate across a run.
 *
 * Every stage declares its input: independent stills take the approved
 * source media (or the approved canonical anchor); only genuine transforms
 * (image-to-video on its keyframe, upscale, export) consume another stage's
 * output via an explicit `dependsOnStageIds` edge. Pure functions throughout
 * - fully unit-testable with no I/O and no inference.
 */

export const QUALITY_PROFILES: QualityProfile[] = ["draft", "balanced", "premium"];

/** Product default for legacy rows and unset requests: final-quality work. */
export const DEFAULT_QUALITY_PROFILE: QualityProfile = "balanced";

export function normalizeQualityProfile(value: unknown): QualityProfile {
  return value === "draft" || value === "balanced" || value === "premium" ? value : DEFAULT_QUALITY_PROFILE;
}

/** Stage kinds that genuinely transform another stage's pixels. */
function kindImpliesStageInput(kind: ProductionStagePlan["kind"]): boolean {
  return kind === "image-to-video" || kind === "upscale";
}

function defaultRoleFor(kind: ProductionStagePlan["kind"], stageId: string): StageRole {
  if (kind === "image-to-video" || stageId === "motion") return "imageToVideo";
  if (kind === "upscale") return "upscale";
  // audio-to-text is unsupported on the Creative surface; subtitle is the
  // closest post-production role so the row still normalizes honestly.
  if (kind === "audio-to-text") return "subtitle";
  // image-to-image variations are guided by the approved source, not derived
  // from a sibling - source-guided, never "preserved" (exact product/logo
  // preservation is unclaimed until place_subject or a dedicated edit
  // adapter is actually wired).
  if (kind === "image-to-image") return "sourceGuidedImage";
  return "conceptImage";
}

/**
 * Fill back-compat defaults for plans stored before the DAG fields existed.
 * Legacy image stages become explicitly independent (approved-source, no
 * edges); a legacy image-to-video stage keeps depending on the keyframe
 * when the plan contains one. Never invents edges between siblings.
 */
export function normalizeStagePlan(
  plan: Array<Partial<ProductionStagePlan> & Pick<ProductionStagePlan, "id" | "kind" | "capability" | "label" | "format">>,
  qualityProfile: QualityProfile = DEFAULT_QUALITY_PROFILE
): ProductionStagePlan[] {
  const ids = new Set(plan.map((s) => s.id));
  return plan.map((s) => {
    const wantsStageInput = s.inputSource
      ? s.inputSource === "stage-output"
      : kindImpliesStageInput(s.kind);
    const dependsOnStageIds = s.dependsOnStageIds ?? (
      wantsStageInput && s.kind === "image-to-video" && ids.has("keyframe") ? ["keyframe"] : []
    );
    return {
      id: s.id,
      kind: s.kind,
      capability: s.capability,
      label: s.label,
      format: s.format,
      dependsOnStageIds,
      inputSource: s.inputSource ?? (wantsStageInput ? "stage-output" : "approved-source"),
      qualityProfile: s.qualityProfile ?? qualityProfile,
      role: s.role ?? defaultRoleFor(s.kind, s.id),
      ...(s.durationSeconds !== undefined || s.kind === "image-to-video"
        ? { durationSeconds: s.durationSeconds ?? 5 }
        : {})
    };
  });
}

export interface PlanValidationError extends Error {
  stageId?: string;
}

/**
 * Validate DAG edges and return stages in dependency (topological) order.
 * Throws naming the offending stage when a dependency is missing from the
 * plan or when stages form a cycle. Ties keep original plan order, so
 * independent stills stay in their authored sequence.
 */
export function validatePlan(stages: ProductionStagePlan[]): ProductionStagePlan[] {
  const byId = new Map(stages.map((s) => [s.id, s]));
  for (const s of stages) {
    for (const dep of s.dependsOnStageIds) {
      if (!byId.has(dep)) {
        const error = new Error(
          `Plan stage "${s.id}" depends on missing stage "${dep}" - the plan is incomplete and cannot run.`
        ) as PlanValidationError;
        error.stageId = s.id;
        throw error;
      }
      if (dep === s.id) {
        const error = new Error(
          `Plan stage "${s.id}" depends on itself - the plan is cyclic and cannot run.`
        ) as PlanValidationError;
        error.stageId = s.id;
        throw error;
      }
    }
  }
  // Kahn's algorithm over plan order (stable for independent stages).
  const indegree = new Map(stages.map((s) => [s.id, 0]));
  for (const s of stages) {
    indegree.set(s.id, new Set(s.dependsOnStageIds).size);
  }
  const ready = stages.filter((s) => (indegree.get(s.id) ?? 0) === 0);
  const ordered: ProductionStagePlan[] = [];
  const queue = [...ready];
  while (queue.length > 0) {
    const current = queue.shift()!;
    ordered.push(current);
    for (const s of stages) {
      if (!s.dependsOnStageIds.includes(current.id)) continue;
      const remaining = (indegree.get(s.id) ?? 1) - 1;
      indegree.set(s.id, remaining);
      if (remaining === 0) queue.push(s);
    }
  }
  if (ordered.length !== stages.length) {
    const stuck = stages.find((s) => !ordered.includes(s));
    const error = new Error(
      `Plan stages form a dependency cycle${stuck ? ` involving "${stuck.id}"` : ""} - the plan cannot run.`
    ) as PlanValidationError;
    if (stuck) error.stageId = stuck.id;
    throw error;
  }
  return ordered;
}

export interface StageInputContext {
  /** Registered, permission-checked source media URL. */
  sourceMediaUrl?: string;
  /**
   * Explicitly approved canonical output URL. NEVER auto-derived from an
   * ordinary keyframe output - a generated keyframe is not human-approved.
   * TODO (Prompt 4): pass the persisted approved-keyframe reference here
   * once the approve-keyframe action and its storage field exist.
   */
  canonicalAnchorUrl?: string;
  /** Ready outputs keyed by stage id (this run + already-delivered jobs). */
  stageOutputs: Map<string, string>;
}

export interface ResolvedStageInput {
  /** Input URL, or undefined when the declared source has nothing ready. */
  url?: string;
  /** What actually feeds the stage - recorded on the job for provenance. */
  resolvedInputSource: StageInputSource;
  /** Dependency stage id when the input is another stage's output. */
  sourceStageId?: string;
  /** Human-readable reason when url is undefined (caller fails honestly). */
  reason?: string;
}

/**
 * Resolve one stage's input pixels. stage-output uses the first declared
 * dependency's ready output; anything else is explicit. Returns url
 * undefined (never a guess) when the declared source is not ready - the
 * pipeline then fails or falls back with the reason recorded.
 */
export function resolveStageInput(stage: ProductionStagePlan, ctx: StageInputContext): ResolvedStageInput {
  if (stage.inputSource === "canonical-anchor") {
    if (ctx.canonicalAnchorUrl) {
      return { url: ctx.canonicalAnchorUrl, resolvedInputSource: "canonical-anchor" };
    }
    return {
      url: undefined,
      resolvedInputSource: "canonical-anchor",
      reason: "This stage requires an approved keyframe anchor. Approve a keyframe first."
    };
  }
  if (stage.inputSource === "stage-output") {
    const depId = stage.dependsOnStageIds[0];
    if (!depId) {
      return {
        url: undefined,
        resolvedInputSource: "stage-output",
        reason: `Stage "${stage.id}" declares a stage-output input but no dependency - the plan is incomplete.`
      };
    }
    const output = ctx.stageOutputs.get(depId);
    if (output) {
      return { url: output, resolvedInputSource: "stage-output", sourceStageId: depId };
    }
    return {
      url: undefined,
      resolvedInputSource: "stage-output",
      sourceStageId: depId,
      reason: `Stage "${stage.id}" needs the "${depId}" output, which is not ready.`
    };
  }
  if (ctx.sourceMediaUrl) {
    return { url: ctx.sourceMediaUrl, resolvedInputSource: "approved-source" };
  }
  return {
    url: undefined,
    resolvedInputSource: "approved-source",
    reason: `Stage "${stage.id}" needs the approved source media, which is missing.`
  };
}

/* ------------------------- execution decisions ------------------------- */

/**
 * An output URL is reusable as another stage's input only when it is a
 * non-empty, parseable HTTPS URL. Failed, empty, malformed, and non-HTTPS
 * outputs are never dispatched downstream - the dependent fails honestly.
 */
export function isUsableOutputUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length === 0) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Prerequisite error naming the missing stage output in plain language. */
export function prerequisiteMessage(stage: ProductionStagePlan, dep: ProductionStagePlan): string {
  return `Generate the ${dep.label} before creating ${stage.label}.`;
}

/**
 * Seed ready outputs from durable AND provider-preview job states, durable
 * first: ready_to_share, then storage_pending, then preview_ready.
 *
 * Per-state URL preference (both candidates must pass isUsableOutputUrl):
 * - ready_to_share: outputUrl first - it is the durable canonical delivery
 *   URL once storage succeeds, while providerOutputUrl may be temporary.
 *   providerOutputUrl is only a fallback when outputUrl is absent/invalid.
 * - storage_pending / preview_ready: providerOutputUrl first (the genuine
 *   provider result), outputUrl as fallback.
 * First usable URL per stage wins; failed, empty, malformed, and non-HTTPS
 * outputs never feed another stage.
 */
export function seedStageOutputs(jobs: ProductionJob[]): Map<string, string> {
  const stageOutputs = new Map<string, string>();
  const seedStatus = (status: ProductionJob["status"], durableFirst: boolean): void => {
    for (const job of jobs) {
      if (job.status !== status || stageOutputs.has(job.stageId)) continue;
      const candidates = durableFirst
        ? [job.outputUrl, job.providerOutputUrl]
        : [job.providerOutputUrl, job.outputUrl];
      const url = candidates.find(isUsableOutputUrl);
      if (url) stageOutputs.set(job.stageId, url);
    }
  };
  seedStatus("ready_to_share", true);
  seedStatus("storage_pending", false);
  seedStatus("preview_ready", false);
  return stageOutputs;
}

export type StageRunAction = "run" | "skip" | "fail";

export interface StageRunDecision {
  stage: ProductionStagePlan;
  action: StageRunAction;
  /** Input URL for run actions. Never set for skip/fail - no dispatch. */
  inputUrl?: string;
  resolvedInputSource?: StageInputSource;
  sourceStageId?: string;
  /** Honest cause for fail actions (surfaced on the job, no provider call). */
  reason?: string;
}

/**
 * Decide every selected stage's fate without side effects: which stages run
 * (with exactly which input URL), which are skipped (unselected or nothing
 * queued), and which fail without any provider call. The pipeline consumes
 * these decisions; tests assert them directly with synthetic job rows.
 *
 * - Outputs seed from durable AND provider-preview states (ready_to_share,
 *   storage_pending, preview_ready), durable first - so a keyframe generated
 *   yesterday feeds a motion-only run today. Failed/malformed/non-HTTPS
 *   outputs never seed.
 * - A stage-output stage whose dependency has no usable output FAILS with a
 *   prerequisite message. There is deliberately no silent approved-source
 *   fallback: motion from the raw source is a different creative act and
 *   must be chosen explicitly, never stumbled into.
 * - canonical-anchor stages fail until an explicitly approved anchor exists
 *   (see StageInputContext TODO) - generated outputs never qualify.
 * - Failed dependencies propagate to dependents only; independent selected
 *   stages still run.
 */
export function decideStageRuns(
  stages: ProductionStagePlan[],
  jobs: ProductionJob[],
  sourceMediaUrl?: string,
  onlyStageIds?: string[],
  canonicalAnchorUrl?: string
): StageRunDecision[] {
  const stageOutputs = seedStageOutputs(jobs);

  const failedStages = new Set(
    jobs.filter((j) => j.status === "failed").map((j) => j.stageId)
  );
  const byId = new Map(stages.map((s) => [s.id, s]));
  const selected = onlyStageIds && onlyStageIds.length > 0
    ? new Set(onlyStageIds)
    : new Set(stages.map((s) => s.id));

  return stages.map((stage) => {
    if (!selected.has(stage.id)) return { stage, action: "skip" as const };
    const runnable = jobs.some(
      (j) => j.stageId === stage.id && (j.status === "queued" || (j.status === "generating" && !j.outputUrl))
    );
    if (!runnable) return { stage, action: "skip" as const };

    const failedDepId = stage.dependsOnStageIds.find((dep) => failedStages.has(dep));
    if (failedDepId) {
      const dep = byId.get(failedDepId);
      return {
        stage,
        action: "fail" as const,
        reason: dep
          ? `Dependency "${dep.label}" failed - "${stage.label}" was not attempted.`
          : `Dependency "${failedDepId}" failed - "${stage.label}" was not attempted.`
      };
    }

    const resolved = resolveStageInput(stage, { sourceMediaUrl, canonicalAnchorUrl, stageOutputs });
    if (!resolved.url) {
      if (stage.inputSource === "stage-output" && resolved.sourceStageId) {
        const dep = byId.get(resolved.sourceStageId);
        return {
          stage,
          action: "fail" as const,
          reason: dep ? prerequisiteMessage(stage, dep) : resolved.reason
        };
      }
      return { stage, action: "fail" as const, reason: resolved.reason ?? `Stage "${stage.id}" has no ready input.` };
    }
    return {
      stage,
      action: "run" as const,
      inputUrl: resolved.url,
      resolvedInputSource: resolved.resolvedInputSource,
      ...(resolved.sourceStageId ? { sourceStageId: resolved.sourceStageId } : {})
    };
  });
}
