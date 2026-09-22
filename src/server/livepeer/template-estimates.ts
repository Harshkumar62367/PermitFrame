import type { BuiltTemplatePlan } from "./template-plan-builder";

/**
 * Pure planning heuristics: rough generation-time estimates. Never a
 * promise, never spend - callers must label the result as rough. Depends
 * on the plan builder's types only.
 */

/**
 * Rough generation-time estimate in minutes: stills ~1.5 min, motion
 * ~3 min + 0.5 min per second. A planning heuristic, never a promise -
 * callers must label it as rough.
 */
export function estimateTemplateMinutes(built: Pick<BuiltTemplatePlan, "stages">): number {
  let minutes = 0;
  for (const s of built.stages) {
    if (s.recipe.kind === "image-to-video") minutes += 3 + 0.5 * (s.durationSeconds ?? 6);
    else if (s.recipe.kind === "upscale") minutes += 2;
    else minutes += 1.5;
  }
  return Math.round(minutes * 10) / 10;
}
