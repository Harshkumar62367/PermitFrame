"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { useInvalidateWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import type { Campaign } from "@/server/types";
import { formatUsd, describeMotionOutputs } from "./studio-model";
import {
  ALL_FORMATS,
  FORMAT_LABELS,
  type TemplateMeta,
  type TemplatePreview as Preview
} from "./template-panel.types";
import {
  buildCustomizeSummary,
  buildSelection,
  computeHasChanges,
  deriveCanApply,
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
  const [comboOpen, setComboOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
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

  const selection = useMemo(
    () =>
      buildSelection({ templateId, packSize, motionOn, formats, stageIds, motionSeconds, durationError, profile, cap }),
    [templateId, packSize, motionOn, formats, stageIds, motionSeconds, durationError, profile, cap]
  );

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
        maxSpendCapUsd: cap.trim() === "" ? undefined : cap
      }),
    [campaign.request.productionSpec, templateId, packSize, motionOn, formats, stageIds, motionSeconds, profile, cap]
  );

  const canApply = deriveCanApply({
    allowed,
    applying,
    hasPreview: !!preview,
    hasPreviewError: !!previewError,
    durationError,
    packSize,
    stageIds
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
    // disclosure state
    comboOpen,
    customizeOpen,
    showDetails,
    // preview/apply lifecycle
    preview,
    previewError,
    previewing,
    notice,
    applying,
    applyError,
    // derived
    durationError,
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
    setComboOpen,
    setCustomizeOpen,
    setShowDetails,
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
