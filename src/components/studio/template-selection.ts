import { ALL_FORMATS } from "./template-panel.types";
import type { TemplateMeta } from "./template-panel.types";

/**
 * Pure selection/normalization helpers for the campaign pack configurator.
 * Moved verbatim out of template-panel.tsx so they are unit-testable; the
 * useTemplateSelection hook is the only stateful caller. No API calls, no
 * React - safe to import from tests and components alike.
 */

/** Draft values as held by the configurator (form-level, pre-normalization). */
export interface DraftSelection {
  templateId: string;
  packSize: string;
  assetTypes: string[];
  formats?: string[];
  stageIds?: string[];
  motionSeconds: number | null;
  qualityProfile: string;
  /** Raw spend-cap input: undefined/"" when empty, otherwise the typed text. */
  maxSpendCapUsd?: number | string;
}

/** Duration validity lives next to the input: invalid values block preview and apply. */
export function validateDuration(motionOn: boolean, motionSeconds: number | null): string | null {
  if (!motionOn) return null;
  if (motionSeconds === null) return "Enter a clip length to continue.";
  if (!Number.isInteger(motionSeconds) || motionSeconds < 3 || motionSeconds > 15) return "Whole seconds, 3-15.";
  return null;
}

export interface SelectionBuildInput {
  templateId: string;
  packSize: string;
  motionOn: boolean;
  formats: string[];
  stageIds: string[];
  motionSeconds: number | null;
  durationError: string | null;
  profile: string;
  cap: string;
}

/** Request selection: all formats means formats are omitted; custom stages only for custom packs. */
export function buildSelection(input: SelectionBuildInput): Record<string, unknown> {
  const sel: Record<string, unknown> = {
    templateId: input.templateId,
    packSize: input.packSize,
    assetTypes: input.motionOn ? ["image", "motion"] : ["image"],
    qualityProfile: input.profile
  };
  if (input.formats.length > 0 && input.formats.length < ALL_FORMATS.length) sel.formats = input.formats;
  if (input.packSize === "custom" && input.stageIds.length > 0) sel.stageIds = input.stageIds;
  if (input.motionOn && input.motionSeconds !== null && input.durationError === null) {
    sel.motionSeconds = input.motionSeconds;
  }
  const capNum = input.cap.trim() === "" ? undefined : Number(input.cap);
  if (capNum !== undefined && Number.isFinite(capNum) && capNum > 0) sel.maxSpendCapUsd = capNum;
  return sel;
}

export interface NormalizedSelection {
  templateId: string;
  packSize: string;
  assetTypes: string[];
  formats: string[] | undefined;
  stageIds: string[];
  motionSeconds: number | undefined;
  qualityProfile?: string;
  cap: string;
}

/**
 * Active-vs-draft comparison on persisted values, not display strings.
 * Normalized fields: template id, pack id, sorted asset types, formats
 * (full set ≡ absent), custom stage ids (sorted, custom only), motion
 * length (motion on only, legacy default 5), profile, spend cap.
 */
export function normalizeSelection(v: DraftSelection): NormalizedSelection {
  const assets = [...v.assetTypes].sort();
  const fmts = !v.formats || v.formats.length === ALL_FORMATS.length ? undefined : [...v.formats].sort();
  return {
    templateId: v.templateId,
    packSize: v.packSize,
    assetTypes: assets,
    formats: fmts,
    stageIds: v.packSize === "custom" ? [...(v.stageIds ?? [])].sort() : [],
    motionSeconds: assets.includes("motion") ? (v.motionSeconds ?? 5) : undefined,
    qualityProfile: v.qualityProfile,
    cap: v.maxSpendCapUsd === undefined || v.maxSpendCapUsd === "" ? "" : String(Number(v.maxSpendCapUsd))
  };
}

/** Persisted plan shape the comparison reads (structural - server branded types assign cleanly). */
export interface PersistedSelection {
  templateId: string;
  packSize: string;
  assetTypes: string[];
  formats?: string[];
  stageIds?: string[];
  motionSeconds?: number | null;
  qualityProfile?: string;
  maxSpendCapUsd?: number;
}

/**
 * A campaign without a persisted production spec is still running its
 * legacy/default plan. The configurator's default selection is only a
 * proposed template plan, not proof that the legacy plan is equivalent -
 * treat it as pending so users can explicitly create the new plan.
 */
export function computeHasChanges(persisted: PersistedSelection | undefined, draft: DraftSelection): boolean {
  if (!persisted) return true;
  const active = normalizeSelection({
    templateId: persisted.templateId,
    packSize: persisted.packSize,
    assetTypes: [...persisted.assetTypes],
    formats: persisted.formats,
    stageIds: persisted.stageIds,
    motionSeconds: persisted.motionSeconds ?? null,
    qualityProfile: persisted.qualityProfile ?? "",
    maxSpendCapUsd: persisted.maxSpendCapUsd
  });
  return JSON.stringify(active) !== JSON.stringify(normalizeSelection(draft));
}

/** Order-preserving toggle against the canonical ordering `all`. */
export function toggleList(list: string[], value: string, all: string[]): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...all.filter((v) => list.includes(v) || v === value)];
}

export interface TemplateSwitch {
  templateId: string;
  /** Stale Custom recipe ids belong to the prior template and must never be submitted. */
  stageIds: [];
  profile: string;
  notice: string | null;
}

/**
 * Switch hygiene as a pure transition: template id updates, custom stage
 * ids are always cleared, shared settings carry over, and an unsupported
 * profile resets to Balanced with notice.
 */
export function switchTemplateSelection(
  currentProfile: string,
  next: Pick<TemplateMeta, "id" | "title" | "compatibleProfiles">
): TemplateSwitch {
  if (!next.compatibleProfiles.includes(currentProfile)) {
    return {
      templateId: next.id,
      stageIds: [],
      profile: "balanced",
      notice: `${next.title} does not support the ${currentProfile} profile - reset to Balanced.`
    };
  }
  return { templateId: next.id, stageIds: [], profile: currentProfile, notice: null };
}

/** Recommended custom set: executable, non-optional recipes. */
export function recommendedStageIds(template: Pick<TemplateMeta, "recipes"> | null): string[] {
  if (!template) return [];
  return template.recipes.filter((r) => r.execution === "create_media" && !r.optional).map((r) => r.id);
}

export interface CanApplyInput {
  allowed: boolean;
  applying: boolean;
  hasPreview: boolean;
  hasPreviewError: boolean;
  durationError: string | null;
  packSize: string;
  stageIds: string[];
}

/** Invalid duration blocks apply; custom packs need at least one stage. */
export function deriveCanApply(input: CanApplyInput): boolean {
  return (
    input.allowed &&
    !input.applying &&
    input.hasPreview &&
    !input.hasPreviewError &&
    input.durationError === null &&
    (input.packSize !== "custom" || input.stageIds.length > 0)
  );
}

export interface CustomizeSummaryInput {
  motionOn: boolean;
  formats: string[];
  profile: string;
  cap: string;
}

export function buildCustomizeSummary(input: CustomizeSummaryInput): string {
  return [
    input.motionOn ? "Images + motion" : "Images",
    input.formats.length === ALL_FORMATS.length ? "Recommended formats" : input.formats.join(", "),
    `${input.profile.charAt(0).toUpperCase() + input.profile.slice(1)} quality`,
    input.cap.trim() === "" ? "No spend cap" : `$${Number(input.cap).toFixed(2)} cap`
  ].join(" · ");
}
