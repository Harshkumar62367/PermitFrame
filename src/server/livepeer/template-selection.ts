import type { ProductionTemplate, TemplateSelection, TemplateStageRecipe } from "./template-catalogue";

/**
 * Pure selection filters: pack, custom ids, formats, motion inclusion.
 * Dependency closure and autoIncluded/requiredFor computation live here;
 * catalogue data is never duplicated (recipes are referenced, and the
 * catalogue order is reused for stable output). No request parsing,
 * validation, or persistence logic.
 */

export interface AutoIncludedPrerequisite {
  id: string;
  label: string;
  requiredFor: string[];
}

export type ClosureResult =
  | { ok: true; recipes: TemplateStageRecipe[]; autoIncluded: AutoIncludedPrerequisite[] }
  | { ok: false; error: string };

/**
 * Recipe filtering per pack/format/asset selection - BEFORE dependency
 * closure. Shared by validation and building so both agree on the pick.
 */
export function pickRecipes(template: ProductionTemplate, selection: TemplateSelection): TemplateStageRecipe[] {
  let picked: TemplateStageRecipe[];
  if (selection.packSize === "custom") {
    const ids = new Set(selection.stageIds ?? []);
    picked = template.recipes.filter((r) => ids.has(r.id));
  } else if (selection.packSize === "quick") {
    picked = template.recipes.filter((r) => r.quickPick);
  } else if (selection.packSize === "campaign") {
    picked = template.recipes.filter((r) => !r.optional);
  } else {
    picked = [...template.recipes];
  }
  const assets = new Set(selection.assetTypes);
  if (selection.formats && selection.formats.length > 0) {
    const formats = new Set(selection.formats);
    picked = picked.filter((r) => formats.has(r.format) || r.assetType !== "image");
  }
  return picked.filter((r) => assets.has(r.assetType));
}

/**
 * Dependency closure over a filtered pick: every executable recipe must
 * bring its transitive executable dependencies, even when pack size,
 * asset toggles, format filters, or custom deselection dropped them. A
 * motion-only selection thus becomes keyframe + motion - never motion on
 * the raw source, and never a silent fallback. A dependency that cannot
 * execute (deferred recipe, unknown id) rejects the selection with a clear
 * pre-apply error instead of an invalid DAG.
 */
export function closeSelectionDependencies(
  template: ProductionTemplate,
  picked: TemplateStageRecipe[]
): ClosureResult {
  const byId = new Map(template.recipes.map((r) => [r.id, r]));
  const included = new Map<string, TemplateStageRecipe>();
  for (const r of picked) included.set(r.id, r);
  const autoIncluded = new Map<string, AutoIncludedPrerequisite>();
  const stack = [...picked];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.execution !== "create_media") continue;
    for (const depId of current.dependsOn) {
      const dep = byId.get(depId);
      if (!dep) {
        return { ok: false, error: `"${current.label}" requires unknown recipe "${depId}" - the template catalogue is inconsistent.` };
      }
      if (dep.execution !== "create_media") {
        return {
          ok: false,
          error: `"${current.label}" requires "${dep.label}", which cannot execute yet (${dep.deferredReason ?? dep.execution}) - remove "${current.label}" or wait for that capability.`
        };
      }
      if (!included.has(dep.id)) {
        included.set(dep.id, dep);
        stack.push(dep);
      }
      if (!picked.some((r) => r.id === dep.id)) {
        const entry = autoIncluded.get(dep.id) ?? { id: dep.id, label: dep.label, requiredFor: [] };
        if (!entry.requiredFor.includes(current.label)) entry.requiredFor.push(current.label);
        autoIncluded.set(dep.id, entry);
      }
    }
  }
  // Preserve catalogue order so independent stills keep their sequence.
  const recipes = template.recipes.filter((r) => included.has(r.id));
  return { ok: true, recipes, autoIncluded: [...autoIncluded.values()] };
}
