import type { PackSize, ProductionTemplate, TemplateAssetType, TemplateFormat, TemplateSelection } from "./template-catalogue";
import {
  MODEL_OVERRIDE_ROLES,
  MODEL_OVERRIDE_STAGE_ROLES,
  MODEL_OVERRIDE_UNAVAILABLE,
  TEMPLATE_ASSET_TYPES,
  TEMPLATE_FORMATS,
  TEMPLATE_IDS,
  PACK_SIZES,
  findRecipe,
  getTemplate,
  type ModelOverrideRole
} from "./template-catalogue";
import type { CatalogueSnapshot } from "./catalogue";
import { modelChoicesForOverride } from "./catalogue";
import { closeSelectionDependencies, pickRecipes } from "./template-selection";
import { normalizeQualityProfile } from "./plan-dag";
import { validateDurationRequest } from "./duration-policy";

/**
 * Raw selection validation (pure): template id, pack, custom bounds,
 * selection closure, and supported profile/format combinations. Every
 * rejection carries the same typed guidance as before - never clamps,
 * never guesses. Depends on catalogue (ids, bounds) and selection
 * (closure pre-apply check), never on the plan builder.
 */

export interface SelectionValidation {
  ok: boolean;
  error?: string;
  spec?: TemplateSelection;
}

/**
 * Validate a raw template selection (pure). Bounds custom packs, rejects
 * out-of-range motion lengths, unknown ids/profiles/formats, and empty
 * asset sets. Never clamps: bad values fail with guidance.
 */
export function validateTemplateSelection(raw: unknown, maxCustomStages: number): SelectionValidation {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "Template selection must be an object." };
  const v = raw as Record<string, unknown>;
  const template = typeof v.templateId === "string" ? getTemplate(v.templateId) : undefined;
  if (!template) return { ok: false, error: `Unknown template "${String(v.templateId)}" - pick one of ${TEMPLATE_IDS.join(", ")}.` };
  if (typeof v.packSize !== "string" || !(PACK_SIZES as string[]).includes(v.packSize)) {
    return { ok: false, error: "Pack size must be one of quick, campaign, full, custom." };
  }
  const packSize = v.packSize as PackSize;
  const assetTypes = Array.isArray(v.assetTypes)
    ? v.assetTypes.filter((a): a is TemplateAssetType => typeof a === "string" && (TEMPLATE_ASSET_TYPES as string[]).includes(a))
    : [];
  if (assetTypes.length === 0) return { ok: false, error: "Select at least one asset type (image, motion, narration, music, subtitles)." };
  let formats: TemplateFormat[] | undefined;
  if (v.formats !== undefined) {
    if (!Array.isArray(v.formats)) return { ok: false, error: "Formats must be an array." };
    formats = [];
    for (const f of v.formats) {
      if (typeof f !== "string" || !(TEMPLATE_FORMATS as string[]).includes(f)) {
        return { ok: false, error: `Unknown format "${String(f)}" - use 9:16, 4:3, 1:1, 16:9.` };
      }
      formats.push(f as TemplateFormat);
    }
    if (formats.length === 0) return { ok: false, error: "Select at least one format." };
  }
  let stageIds: string[] | undefined;
  if (packSize === "custom") {
    if (!Array.isArray(v.stageIds) || v.stageIds.length === 0) {
      return { ok: false, error: "Custom packs need an explicit stage list." };
    }
    stageIds = v.stageIds.filter((s): s is string => typeof s === "string");
    const unknown = stageIds.filter((id) => !findRecipe(template, id));
    if (unknown.length > 0) return { ok: false, error: `Unknown stage ids for ${template.id}: ${unknown.join(", ")}.` };
    if (stageIds.length > maxCustomStages) {
      return { ok: false, error: `Custom packs are bounded at ${maxCustomStages} stages - selected ${stageIds.length}.` };
    }
  }
  const profile = normalizeQualityProfile(v.qualityProfile);
  if (typeof v.qualityProfile === "string" && !template.compatibleProfiles.includes(profile)) {
    return { ok: false, error: `Template "${template.id}" does not support the ${profile} profile.` };
  }
  let motionSeconds: number | undefined;
  if (v.motionSeconds !== undefined) {
    // Global gate only - model fit resolves per stage through the duration
    // policy (bucket adjustment or honest rejection, never a silent clamp).
    // Client-supplied resolved values are ignored and recomputed.
    const checked = validateDurationRequest(v.motionSeconds);
    if (!checked.ok) return checked;
    motionSeconds = checked.seconds;
  }
  let maxSpendCapUsd: number | undefined;
  if (v.maxSpendCapUsd !== undefined && v.maxSpendCapUsd !== null && v.maxSpendCapUsd !== "") {
    const n = typeof v.maxSpendCapUsd === "string" ? Number(v.maxSpendCapUsd) : v.maxSpendCapUsd;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
      return { ok: false, error: "Spend cap must be a positive USD amount." };
    }
    maxSpendCapUsd = Math.round(n * 100) / 100;
  }
  // Optional expert model choice. Absent (or blank) means Automatic.
  // Unknown keys, non-string values, and over-long names are rejected;
  // availability and role compatibility are enforced live by
  // checkModelOverrides on preview/apply, never here (pure).
  let modelOverrides: Partial<Record<ModelOverrideRole, string>> | undefined;
  if (v.modelOverrides !== undefined) {
    if (typeof v.modelOverrides !== "object" || v.modelOverrides === null || Array.isArray(v.modelOverrides)) {
      return { ok: false, error: "Model overrides must look like { conceptImage, imageToVideo } - or omit them for Automatic." };
    }
    modelOverrides = {};
    for (const [key, value] of Object.entries(v.modelOverrides as Record<string, unknown>)) {
      if (key !== "conceptImage" && key !== "imageToVideo") {
        return { ok: false, error: `Unknown model override "${key}" - overrides apply to conceptImage and imageToVideo only.` };
      }
      if (typeof value !== "string") {
        return { ok: false, error: `Model override for ${key} must be a model name - or omit it for Automatic.` };
      }
      const name = value.trim();
      if (name === "") continue;
      if (name.length > 120) {
        return { ok: false, error: `Model override for ${key} must be 120 characters or fewer.` };
      }
      modelOverrides[key] = name;
    }
    if (Object.keys(modelOverrides).length === 0) modelOverrides = undefined;
  }
  const candidate: TemplateSelection = {
    templateId: template.id,
    packSize,
    assetTypes,
    ...(formats ? { formats } : {}),
    ...(stageIds ? { stageIds } : {}),
    ...(motionSeconds !== undefined ? { motionSeconds } : {}),
    qualityProfile: profile,
    ...(maxSpendCapUsd !== undefined ? { maxSpendCapUsd } : {}),
    ...(modelOverrides ? { modelOverrides } : {})
  };
  // Dependency closure pre-apply: a selection whose dependency cannot
  // execute is rejected here, never as an invalid DAG later.
  const closed = closeSelectionDependencies(template, pickRecipes(template, candidate));
  if (!closed.ok) return closed;
  return { ok: true, spec: candidate };
}

export type ModelOverrideCheck = { ok: true } | { ok: false; error: string };

/**
 * Live enforcement for expert model choices (preview and apply share it).
 * Pure over a caller-supplied snapshot, so tests never touch discovery:
 * - each present override needs a matching selected executable recipe
 *   (image choice needs an image-generation role; motion needs
 *   image-to-video) - never critic, preservation/product-photo tooling,
 *   upscale, or deferred audio;
 * - when discovery is reachable, the name must be currently available AND
 *   inside the role's verified family (same choice universe the UI
 *   offers), otherwise the exact safe refusal;
 * - when discovery is unreachable, the override passes through and the
 *   dispatch-time guard decides - the same leniency the automatic path
 *   has always had.
 */
export function checkModelOverrides(
  spec: TemplateSelection,
  template: ProductionTemplate,
  snapshot: CatalogueSnapshot
): ModelOverrideCheck {
  const overrides = spec.modelOverrides;
  if (!overrides || (overrides.conceptImage === undefined && overrides.imageToVideo === undefined)) {
    return { ok: true };
  }
  const closed = closeSelectionDependencies(template, pickRecipes(template, spec));
  if (!closed.ok) return { ok: false, error: closed.error };
  const execRoles = new Set(
    closed.recipes.filter((r) => r.execution === "create_media").map((r) => r.role)
  );
  for (const key of MODEL_OVERRIDE_ROLES) {
    const name = overrides[key];
    if (!name) continue;
    if (!MODEL_OVERRIDE_STAGE_ROLES[key].some((r) => execRoles.has(r))) {
      return {
        ok: false,
        error:
          key === "conceptImage"
            ? "Model choice for images needs a selected image recipe - select an image deliverable or choose Automatic."
            : "Model choice for motion needs a selected motion recipe - turn motion back on or choose Automatic."
      };
    }
    if (!snapshot.reachable) continue;
    const offered = new Set(modelChoicesForOverride(snapshot, key).map((c) => c.name));
    if (!offered.has(name)) {
      return { ok: false, error: MODEL_OVERRIDE_UNAVAILABLE };
    }
  }
  return { ok: true };
}
