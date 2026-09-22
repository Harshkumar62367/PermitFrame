/**
 * Compatibility façade (target <220 lines): every name formerly exported
 * from this file still imports from here - routes, platform, tests, and
 * the runner keep working unchanged. All behavior lives in the extracted
 * modules (lifecycle, template application, production, variations);
 * nothing here owns a rule or duplicates an implementation.
 *
 * Dependency direction is one-way: the four modules import the shared
 * guards from campaign-lifecycle, never this façade, so no cycle can form.
 */

export {
  loadCampaign,
  requireWorkspaceOwner,
  throwIfArchived,
  createCampaign,
  createCampaignIdempotent,
  rePreflight,
  updateCampaignBrief,
  approveCampaign,
  deleteCampaign,
  refreshVerificationSnapshot,
  archiveCampaign
} from "./campaign-lifecycle";
export type { CreateCampaignInput, BriefPatch } from "./campaign-lifecycle";
export {
  ACTIVE_JOB_STATUSES,
  checkTemplateApplyReadiness,
  applyTemplateSpec
} from "./campaign-template-application";
export { startProduction, cancelCampaignJobs } from "./campaign-production";
export { reviseStage, createVariationRun } from "./campaign-variations";
