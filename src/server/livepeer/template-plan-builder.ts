import type { ProductionStagePlan, QualityProfile } from "../types";
import type { ProductionTemplate, TemplateSelection, TemplateStageRecipe } from "./template-catalogue";
import { MODEL_OVERRIDE_STAGE_ROLES, type ModelOverrideRole } from "./template-catalogue";
import type { AutoIncludedPrerequisite } from "./template-selection";
import { closeSelectionDependencies, pickRecipes } from "./template-selection";
import { resolveMotionDuration, type DurationMetadata } from "./duration-policy";

/**
 * Plan assembly: valid recipes become executable production stages with
 * duration/aspect/profile metadata threaded through, then convert to
 * persisted DAG stages. Stage ids, dependencies, roles, capabilities,
 * prompts, and labels pass through untouched. Deferred recipes stay
 * deferred - no provider tool is ever wired here.
 */

export interface CapabilityResolution {
  capability: string;
  fallbackFrom?: string;
  /**
   * User-pinned model for this stage (Short Clip advanced model choice).
   * Present only when an explicit override resolved it - capability equals
   * this value and no fallback was recorded. Absent on automatic stages.
   */
  requestedCapability?: string;
}

/**
 * Expert override for one stage role, if the selection pins it. The
 * concept choice covers the concept family (source-guided variations ride
 * the concept pick); every other role resolves automatically. Returns
 * undefined for Automatic (absent) overrides.
 */
export function overrideForRole(
  role: TemplateStageRecipe["role"],
  overrides: Partial<Record<ModelOverrideRole, string>> | undefined
): string | undefined {
  if (!overrides) return undefined;
  if (overrides.conceptImage && MODEL_OVERRIDE_STAGE_ROLES.conceptImage.includes(role)) {
    return overrides.conceptImage;
  }
  if (overrides.imageToVideo && MODEL_OVERRIDE_STAGE_ROLES.imageToVideo.includes(role)) {
    return overrides.imageToVideo;
  }
  return undefined;
}

export interface BuiltTemplateStage {
  recipe: TemplateStageRecipe;
  capability: string;
  fallbackFrom?: string;
  /** User-pinned model for this stage - persisted, never substituted. */
  requestedCapability?: string;
  /** Resolved clip length (motion only). */
  durationSeconds?: number;
  /** Requested clip length before adjustment (motion only). */
  requestedDurationSeconds?: number;
  /** Why resolved differs from requested, if it does. */
  durationNote?: string;
  /** Duration-limit provenance for the applied resolution. */
  durationSource?: "provider-metadata" | "documented-model-policy" | "product-range-unverified";
}

export interface DeferredTemplateStage {
  recipe: TemplateStageRecipe;
  reason: string;
}

export interface BuiltTemplatePlan {
  template: ProductionTemplate;
  stages: BuiltTemplateStage[];
  deferred: DeferredTemplateStage[];
  executableCount: number;
  /** Planned outputs incl. deferred (estimated output count). */
  outputCount: number;
  /** Dependencies auto-included by closure (shown as "Required for …"). */
  autoIncluded: AutoIncludedPrerequisite[];
}

export type BuildResult =
  | { ok: true; plan: BuiltTemplatePlan }
  | { ok: false; error: string };

/**
 * Assemble executable stages + deferred list from a validated selection.
 * Pure: capability routing is injected so tests never touch discovery.
 * Dependency closure runs first - the returned plan is always
 * dependency-closed, and auto-included prerequisites are reported.
 * Motion durations resolve through the duration policy per stage; a model
 * rejection fails the build honestly (no silent clamp, no guessed length).
 */
export function buildTemplateStages(
  template: ProductionTemplate,
  selection: TemplateSelection,
  resolveCapability: (role: TemplateStageRecipe["role"]) => CapabilityResolution,
  durationMetadata?: Record<string, DurationMetadata>
): BuildResult {
  const closed = closeSelectionDependencies(template, pickRecipes(template, selection));
  if (!closed.ok) return closed;
  const stages: BuiltTemplateStage[] = [];
  const deferred: DeferredTemplateStage[] = [];
  for (const recipe of closed.recipes) {
    if (recipe.execution === "deferred") {
      deferred.push({ recipe, reason: recipe.deferredReason ?? "Not dispatched by this production task." });
      continue;
    }
    // Explicit expert override pins the exact capability for every matching
    // stage - no fallback recording, never substituted. Without an override
    // the injected automatic resolution runs exactly as before.
    const pinned = overrideForRole(recipe.role, selection.modelOverrides);
    const resolved = pinned
      ? { capability: pinned, requestedCapability: pinned }
      : resolveCapability(recipe.role);
    if (recipe.kind === "image-to-video") {
      const requested = selection.motionSeconds ?? recipe.defaultDurationSeconds ?? 6;
      const duration = resolveMotionDuration(requested, resolved.capability, durationMetadata?.[resolved.capability]);
      if (!duration.ok) return { ok: false, error: `"${recipe.label}": ${duration.error}` };
      stages.push({
        recipe,
        capability: resolved.capability,
        ...(resolved.fallbackFrom ? { fallbackFrom: resolved.fallbackFrom } : {}),
        ...(resolved.requestedCapability ? { requestedCapability: resolved.requestedCapability } : {}),
        durationSeconds: duration.resolvedSeconds,
        requestedDurationSeconds: duration.requestedSeconds,
        ...(duration.adjusted && duration.adjustmentReason ? { durationNote: duration.adjustmentReason } : {}),
        durationSource: duration.source
      });
      continue;
    }
    stages.push({
      recipe,
      capability: resolved.capability,
      ...(resolved.fallbackFrom ? { fallbackFrom: resolved.fallbackFrom } : {}),
      ...(resolved.requestedCapability ? { requestedCapability: resolved.requestedCapability } : {})
    });
  }
  return {
    ok: true,
    plan: {
      template,
      stages,
      deferred,
      executableCount: stages.length,
      outputCount: stages.length + deferred.length,
      autoIncluded: closed.autoIncluded
    }
  };
}

/** Convert built stages into persisted plan stages (DAG-complete). */
export function toPlanStages(built: BuiltTemplatePlan, profile: QualityProfile): ProductionStagePlan[] {
  return built.stages.map((s) => ({
    id: s.recipe.id,
    kind: s.recipe.kind,
    capability: s.capability,
    // Motion labels carry the resolved clip length so plan, queue, review,
    // and receipts all name the actual deliverable (e.g. "… · 6s").
    label:
      s.recipe.kind === "image-to-video" && s.durationSeconds !== undefined
        ? `${s.recipe.label} · ${s.durationSeconds}s`
        : s.recipe.label,
    format: s.recipe.format,
    dependsOnStageIds: [...s.recipe.dependsOn],
    inputSource: s.recipe.inputSource,
    qualityProfile: profile,
    role: s.recipe.role,
    // Fidelity requirement travels only when strict; absent reads as
    // conceptual everywhere (policy, pills, gates).
    ...(s.recipe.fidelity && s.recipe.fidelity !== "conceptual" ? { fidelity: s.recipe.fidelity } : {}),
    ...(s.durationSeconds !== undefined ? { durationSeconds: s.durationSeconds } : {}),
    ...(s.requestedDurationSeconds !== undefined ? { requestedDurationSeconds: s.requestedDurationSeconds } : {}),
    ...(s.requestedCapability ? { requestedCapability: s.requestedCapability } : {}),
    ...(s.durationNote ? { durationNote: s.durationNote } : {}),
    ...(s.durationSource ? { durationSource: s.durationSource } : {}),
    ...(s.fallbackFrom ? { fallbackFrom: s.fallbackFrom } : {})
  }));
}
