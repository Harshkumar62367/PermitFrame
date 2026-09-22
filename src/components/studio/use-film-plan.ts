"use client";

import { useMemo, useState } from "react";
import { apiPost } from "@/lib/api";
import { useInvalidateWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import type { Campaign } from "@/server/types";
import {
  createStarterScenes,
  describeFilmPlanSummary,
  validateFilmPlan,
  type FilmMode,
  type FilmPlan,
  type FilmScene,
  type FilmTargetDuration
} from "@/server/livepeer/film-plan";
import type { TemplateFormat } from "@/server/livepeer/template-catalogue";

interface UseFilmPlanInput {
  campaign: Campaign;
  allowed: boolean;
  onChanged: () => Promise<void>;
}

/**
 * Draft state for Campaign Film planning (first half: plan + confirm only).
 * Owns mode, target, aspect, title, budget, and the ordered scene list -
 * starters regenerate deterministically when the total changes, edits apply
 * per scene, and validation runs locally before review. Saving persists the
 * validated plan to the campaign request JSON; it never rebuilds preflight
 * and never submits a provider job. No LLM, no provider calls.
 */
export function useFilmPlan({ campaign, allowed, onChanged }: UseFilmPlanInput) {
  const persisted = campaign.request.filmPlan ?? null;
  const [mode, setMode] = useState<FilmMode>(persisted?.mode ?? "short_clip");
  const [target, setTarget] = useState<FilmTargetDuration>(persisted?.targetDurationSeconds ?? 30);
  const [aspect, setAspect] = useState<TemplateFormat>(persisted?.aspectRatio ?? "9:16");
  const [title, setTitle] = useState<string>(persisted?.title ?? "");
  const [budget, setBudget] = useState<string>(persisted ? String(persisted.budgetCapUsd) : "");
  const [scenes, setScenes] = useState<FilmScene[]>(() => persisted?.scenes ?? createStarterScenes(30, "9:16"));
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();

  const draft = useMemo(
    () => ({
      mode,
      title,
      targetDurationSeconds: target,
      aspectRatio: aspect,
      budgetCapUsd: budget.trim() === "" ? undefined : Number(budget),
      scenes,
      finishing: { requested: [] as [] }
    }),
    [mode, title, target, aspect, budget, scenes]
  );

  const validation = useMemo(
    () => (mode === "campaign_film" ? validateFilmPlan(draft) : null),
    // draft identity changes every render by design (built above).
    [mode, draft]
  );
  const validPlan: FilmPlan | null = validation && validation.ok ? validation.filmPlan : null;
  const filmError = validation && !validation.ok ? validation.error : null;

  const summary = useMemo(
    () => describeFilmPlanSummary({ targetDurationSeconds: target, scenes }),
    [target, scenes]
  );
  const totalSeconds = useMemo(() => scenes.reduce((sum, s) => sum + (Number.isFinite(s.durationSeconds) ? s.durationSeconds : 0), 0), [scenes]);

  function setTargetDuration(next: FilmTargetDuration) {
    setTarget(next);
    // Picking a total loads the matching deterministic starter scenes;
    // per-scene edits happen afterwards on this fresh plan.
    setScenes(createStarterScenes(next, aspect));
    setSavedNotice(null);
  }

  function setAspectRatio(next: TemplateFormat) {
    setAspect(next);
    setSavedNotice(null);
  }

  function updateScene(id: string, patch: Partial<Pick<FilmScene, "title" | "durationSeconds" | "visualDirection" | "sourceIntent" | "format">>) {
    setScenes((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    setSavedNotice(null);
  }

  const canReview = allowed && mode === "campaign_film" && validPlan !== null;

  /**
   * Server dry-run first: review and save share one validation authority.
   * The modal opens only after the server accepts the same plan object;
   * a server rejection surfaces here and the modal stays closed.
   */
  async function openReview() {
    if (!canReview || !validPlan || reviewing) return;
    setReviewing(true);
    setReviewError(null);
    setSaveError(null);
    try {
      await apiPost<{ ok: boolean }>(
        `/api/campaigns/${campaign.id}/film-plan`,
        { filmPlan: validPlan, dryRun: true },
        undefined,
        60000
      );
      setReviewOpen(true);
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : "The server rejected this film plan. Nothing was opened.");
    } finally {
      setReviewing(false);
    }
  }

  async function confirmSave() {
    if (!validPlan || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await apiPost(`/api/campaigns/${campaign.id}/film-plan`, { filmPlan: validPlan }, undefined, 60000);
      invalidateSnapshot();
      await onChanged();
      setReviewOpen(false);
      setSavedNotice("Film plan saved. Generation and final assembly have not started yet.");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Saving the film plan failed. Nothing was changed.");
    } finally {
      setSaving(false);
    }
  }

  return {
    mode,
    setMode,
    target,
    setTargetDuration,
    aspect,
    setAspectRatio,
    title,
    setTitle,
    budget,
    setBudget,
    scenes,
    updateScene,
    reviewOpen,
    setReviewOpen,
    reviewing,
    reviewError,
    saving,
    saveError,
    savedNotice,
    persisted,
    validation,
    validPlan,
    filmError,
    summary,
    totalSeconds,
    canReview,
    openReview,
    confirmSave
  };
}

export type FilmPlanViewModel = ReturnType<typeof useFilmPlan>;
