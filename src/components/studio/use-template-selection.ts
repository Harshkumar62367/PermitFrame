"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { useInvalidateWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import type { Campaign } from "@/server/types";
import { formatUsd, describeMotionOutputs } from "./studio-model";
import { describeLegacyShortClipSeconds } from "@/server/livepeer/film-plan";
import {
  ALL_FORMATS,
  FORMAT_LABELS,
  type TemplateMeta,
  type TemplatePreview as Preview
} from "./template-panel.types";
import type { ModelChoice } from "@/server/livepeer/catalogue";
import {
  MODEL_AUTOMATIC,
  MODEL_CHOICES_UNAVAILABLE,
  applyModelChoicesResponse,
  buildSelection,
  buildCustomizeSummary,
  computeHasChanges,
  deriveCanApply,
  isModelChoiceStale,
  recommendedStageIds,
  switchTemplateSelection,
  toggleList,
  validateDuration
} from "./template-selection";

interface UseTemplateSelectionInput {
  campaign: Campaign;
  allowed: boolean;
  onChanged: () => Promise<void>;
}

/**
 * Canonical draft-selection state for the campaign pack configurator.
 * Owns all selection, preview, validation, debounce, normalization, apply,
 * errors, and callback behavior - the only place draft selection and API
 * lifecycle state live. View components receive values and callbacks only.
 */
export function useTemplateSelection({ campaign, allowed, onChanged }: UseTemplateSelectionInput) {
  const [templates, setTemplates] = useState<TemplateMeta[] | null>(null);
  const spec = campaign.request.productionSpec;
  const [templateId, setTemplateId] = useState<string>(spec?.templateId ?? "creator-campaign");
  const [packSize, setPackSize] = useState<string>(spec?.packSize ?? "campaign");
  const [motionOn, setMotionOn] = useState<boolean>(() => (spec?.assetTypes ?? ["image", "motion"]).includes("motion"));
  const [formats, setFormats] = useState<string[]>(spec?.formats ?? [...ALL_FORMATS]);
  const [stageIds, setStageIds] = useState<string[]>(spec?.stageIds ?? []);
  // New selections default to a selected 5s chip; persisted/legacy values
  // (e.g. 6s) render as a temporary "current plan" chip instead of nothing.
  const [motionSeconds, setMotionSeconds] = useState<number | null>(spec?.motionSeconds ?? 5);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [profile, setProfile] = useState<string>(spec?.qualityProfile ?? campaign.request.qualityProfile ?? "balanced");
  const [cap, setCap] = useState<string>(spec?.maxSpendCapUsd !== undefined ? String(spec.maxSpendCapUsd) : "");
  // Expert model choice per role: "automatic" or a capability name. Saved
  // pins hydrate; anything else normalizes to Automatic.
  const savedOverrides = spec?.modelOverrides;
  const [imageModel, setImageModel] = useState<string>(
    typeof savedOverrides?.conceptImage === "string" && savedOverrides.conceptImage.trim() !== ""
      ? savedOverrides.conceptImage
      : MODEL_AUTOMATIC
  );
  const [motionModel, setMotionModel] = useState<string>(
    typeof savedOverrides?.imageToVideo === "string" && savedOverrides.imageToVideo.trim() !== ""
      ? savedOverrides.imageToVideo
      : MODEL_AUTOMATIC
  );
  const [modelChoices, setModelChoices] = useState<{ conceptImage: ModelChoice[]; imageToVideo: ModelChoice[] } | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsReachable, setModelsReachable] = useState<boolean | null>(null);
  const [modelsRefresh, setModelsRefresh] = useState(0);
  const [comboOpen, setComboOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();

  useEffect(() => {
    let active = true;
    apiGet<{ templates: TemplateMeta[] }>("/api/templates", undefined, 15000).then(
      (d) => {
        if (active && Array.isArray(d.templates)) setTemplates(d.templates);
      },
      () => undefined
    );
    return () => {
      active = false;
    };
  }, []);

  const template = useMemo(() => templates?.find((t) => t.id === templateId) ?? null, [templates, templateId]);

  const durationError = validateDuration(motionOn, motionSeconds);

  // Legacy persisted lengths (e.g. 40s) render the exact legacy notice
  // until the user picks a valid chip - a freshly typed invalid value
  // keeps the standard duration error instead.
  const persistedSeconds = spec?.motionSeconds ?? null;
  const legacyClipMessage =
    persistedSeconds !== null && motionSeconds === persistedSeconds
      ? describeLegacyShortClipSeconds(persistedSeconds)
      : null;

  const selection = useMemo(
    () =>
      buildSelection({ templateId, packSize, motionOn, formats, stageIds, motionSeconds, durationError, profile, cap, modelOverrides: { conceptImage: imageModel, imageToVideo: motionModel } }),
    [templateId, packSize, motionOn, formats, stageIds, motionSeconds, durationError, profile, cap, imageModel, motionModel]
  );

  // Expert model choices: same-origin safe endpoint, display data only.
  // Refresh refetches the lists; nothing here reloads the page. An
  // unreachable-discovery envelope maps to neutral unavailable state (no
  // authoritative list, no stale markers); transport failures keep the
  // previous lists and only surface the retry copy.
  useEffect(() => {
    let active = true;
    apiGet<{ ok: boolean; reachable?: boolean; choices?: { conceptImage: ModelChoice[]; imageToVideo: ModelChoice[] }; error?: string }>(
      "/api/livepeer/model-choices",
      undefined,
      15000
    ).then(
      (d) => {
        if (!active) return;
        setModelsLoading(false);
        if (!d.ok) {
          setModelsError(MODEL_CHOICES_UNAVAILABLE);
          return;
        }
        const next = applyModelChoicesResponse(d);
        setModelChoices(next.choices);
        setModelsReachable(next.reachable);
        setModelsError(next.error);
      },
      () => {
        if (!active) return;
        setModelsLoading(false);
        setModelsError(MODEL_CHOICES_UNAVAILABLE);
      }
    );
    return () => {
      active = false;
    };
  }, [modelsRefresh]);

  function refreshModelChoices() {
    setModelsLoading(true);
    setModelsError(null);
    setModelsRefresh((n) => n + 1);
  }

  // Role presence comes from the server-computed preview (executable
  // stages only): the image choice appears only with an image-generation
  // role selected, motion only with image-to-video. Never critic,
  // preservation/product-photo tooling, upscale, or deferred audio.
  const previewRoles = useMemo(() => new Set((preview?.stages ?? []).map((s) => s.role)), [preview]);
  const hasImageRole = previewRoles.has("conceptImage") || previewRoles.has("sourceGuidedImage");
  const hasMotionRole = previewRoles.has("imageToVideo");

  // A saved pin is stale only against a reachable live list that omits it
  // (see isModelChoiceStale): unreachable discovery stays neutral and
  // Apply stays locally unblocked, deferring to the server guards.
  const imageModelStale = isModelChoiceStale(
    imageModel,
    modelChoices?.conceptImage ?? null,
    modelsReachable,
    modelsLoading
  );
  const motionModelStale = isModelChoiceStale(
    motionModel,
    modelChoices?.imageToVideo ?? null,
    modelsReachable,
    modelsLoading
  );
  const modelsBlocked = imageModelStale || motionModelStale;

  function fetchPreviewNow() {
    setPreviewError(null);
    setPreviewing(true);
    apiPost<{ ok: boolean; preview: Preview }>(
      `/api/campaigns/${campaign.id}/template`,
      { selection, dryRun: true },
      undefined,
      60000
    ).then(
      (d) => {
        setPreview(d.preview);
        setPreviewing(false);
      },
      (e) => {
        setPreview(null);
        setPreviewing(false);
        setPreviewError(e instanceof Error ? e.message : "Preview failed.");
      }
    );
  }

  // Live preview (dry run - nothing persisted) as the selection changes.
  useEffect(() => {
    if (!allowed) return;
    const timer = setTimeout(() => {
      if (motionOn && durationError !== null) {
        setPreview(null);
        setPreviewError(null);
        return;
      }
      fetchPreviewNow();
    }, 450);
    return () => clearTimeout(timer);
    // Selection object identity changes every render by design (built above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, campaign.id, selection]);

  function toggleFormat(value: string) {
    setFormats((prev) => toggleList(prev, value, ["9:16", "4:5", "1:1", "16:9"]));
  }

  function toggleStage(value: string) {
    if (!template) return;
    const all = template.recipes.map((x) => x.id);
    setStageIds((prev) => toggleList(prev, value, all));
  }

  async function apply() {
    if (applying || !allowed) return;
    setApplying(true);
    setApplyError(null);
    try {
      await apiPost(`/api/campaigns/${campaign.id}/template`, { selection }, undefined, 120000);
      invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : "Template apply failed. Nothing was changed.");
    } finally {
      setApplying(false);
    }
  }

  function switchTemplate(next: TemplateMeta) {
    const switched = switchTemplateSelection(profile, next);
    setTemplateId(switched.templateId);
    setStageIds(switched.stageIds);
    setNotice(switched.notice);
    setComboOpen(false);
    setProfile(switched.profile);
  }

  function useRecommendedStages() {
    if (!template) return;
    setStageIds(recommendedStageIds(template));
  }

  const appliedTitle = campaign.request.productionSpec
    ? (templates?.find((t) => t.id === campaign.request.productionSpec?.templateId)?.title ?? campaign.request.productionSpec.templateId)
    : "Default pack";
  const appliedCount = (campaign.preflight?.plan ?? []).length;

  const hasChanges = useMemo(
    () =>
      computeHasChanges(campaign.request.productionSpec, {
        templateId,
        packSize,
        assetTypes: motionOn ? ["image", "motion"] : ["image"],
        formats,
        stageIds,
        motionSeconds,
        qualityProfile: profile,
        maxSpendCapUsd: cap.trim() === "" ? undefined : cap,
        modelOverrides: { conceptImage: imageModel, imageToVideo: motionModel }
      }),
    [campaign.request.productionSpec, templateId, packSize, motionOn, formats, stageIds, motionSeconds, profile, cap, imageModel, motionModel]
  );

  const canApply = deriveCanApply({
    allowed,
    applying,
    hasPreview: !!preview,
    hasPreviewError: !!previewError,
    durationError,
    packSize,
    stageIds,
    modelsBlocked
  });
  const customizeSummary = buildCustomizeSummary({ motionOn, formats, profile, cap });

  const motionStages = preview?.stages.filter((s) => s.kind === "image-to-video") ?? [];
  const mediaLine = !motionOn
    ? "Images"
    : describeMotionOutputs(motionStages.map((s) => s.durationSeconds));
  const formatLine = preview
    ? [...new Set(preview.stages.map((s) => s.format))].map((f) => FORMAT_LABELS[f] ?? f).join(" · ")
    : "";

  function refreshPreview() {
    fetchPreviewNow();
  }

  return {
    // resolved data
    templates,
    template,
    // selection values
    templateId,
    packSize,
    motionOn,
    formats,
    stageIds,
    motionSeconds,
    advancedOpen,
    profile,
    cap,
    imageModel,
    motionModel,
    modelChoices,
    modelsLoading,
    modelsError,
    hasImageRole,
    hasMotionRole,
    imageModelStale,
    motionModelStale,
    modelsBlocked,
    // disclosure state
    comboOpen,
    customizeOpen,
    showDetails,
    modelsOpen,
    // preview/apply lifecycle
    preview,
    previewError,
    previewing,
    notice,
    applying,
    applyError,
    // derived
    durationError,
    legacyClipMessage,
    selection,
    hasChanges,
    canApply,
    customizeSummary,
    appliedTitle,
    appliedCount,
    motionStages,
    mediaLine,
    formatLine,
    // setters
    setPackSize,
    setMotionOn,
    setMotionSeconds,
    setAdvancedOpen,
    setProfile,
    setCap,
    setImageModel,
    setMotionModel,
    refreshModelChoices,
    setComboOpen,
    setCustomizeOpen,
    setShowDetails,
    setModelsOpen,
    setStageIds,
    // callbacks
    toggleFormat,
    toggleStage,
    switchTemplate,
    useRecommendedStages,
    apply,
    refreshPreview,
    formatUsd
  };
}

export type TemplateSelectionViewModel = ReturnType<typeof useTemplateSelection>;
