import type { PackSize, TemplateAssetType, TemplateFormat, TemplateSelection } from "./template-catalogue";
import { TEMPLATE_ASSET_TYPES, TEMPLATE_FORMATS, TEMPLATE_IDS, PACK_SIZES, findRecipe, getTemplate } from "./template-catalogue";
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
        return { ok: false, error: `Unknown format "${String(f)}" - use 9:16, 4:5, 1:1, 16:9.` };
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
  const candidate: TemplateSelection = {
    templateId: template.id,
    packSize,
    assetTypes,
    ...(formats ? { formats } : {}),
    ...(stageIds ? { stageIds } : {}),
    ...(motionSeconds !== undefined ? { motionSeconds } : {}),
    qualityProfile: profile,
    ...(maxSpendCapUsd !== undefined ? { maxSpendCapUsd } : {})
  };
  // Dependency closure pre-apply: a selection whose dependency cannot
  // execute is rejected here, never as an invalid DAG later.
  const closed = closeSelectionDependencies(template, pickRecipes(template, candidate));
  if (!closed.ok) return closed;
  return { ok: true, spec: candidate };
}
