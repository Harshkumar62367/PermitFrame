/**
 * Compatibility façade (target <200 lines): the only supported import
 * path for template-driven production plans. Every type and function
 * formerly exported from this file still imports from here unchanged -
 * engine, routes, and tests keep working with zero churn.
 *
 * All behavior lives in the extracted modules; nothing here owns a rule
 * or duplicates an implementation. The graph is one-way: catalogue ←
 * selection ← validation / plan-builder ← estimates, and this façade
 * re-exports them all.
 *
 * Only create_media-backed recipes execute today (image + motion +
 * upscale). Narration/music/subtitle recipes stay deferred - see
 * template-catalogue.
 */

export type {
  TemplateId,
  PackSize,
  TemplateAssetType,
  TemplateFormat,
  TemplateSelection,
  RecipeExecution,
  TemplateStageRecipe,
  PromptContext,
  ToolStrategy,
  ProductionTemplate
} from "./template-catalogue";
export {
  TEMPLATE_IDS,
  PACK_SIZES,
  PACK_SIZE_GUIDANCE,
  TEMPLATE_ASSET_TYPES,
  TEMPLATE_FORMATS,
  DEFERRED_MOTION_REASON,
  listTemplates,
  getTemplate,
  findRecipe,
  findRecipeAnywhere
} from "./template-catalogue";
export type { AutoIncludedPrerequisite, ClosureResult } from "./template-selection";
export { pickRecipes, closeSelectionDependencies } from "./template-selection";
export type { SelectionValidation } from "./template-validation";
export { validateTemplateSelection } from "./template-validation";
export type {
  CapabilityResolution,
  BuiltTemplateStage,
  DeferredTemplateStage,
  BuiltTemplatePlan,
  BuildResult
} from "./template-plan-builder";
export { buildTemplateStages, toPlanStages } from "./template-plan-builder";
export { estimateTemplateMinutes } from "./template-estimates";
