"use client";

import { useMemo, useState } from "react";
import { apiPost } from "@/lib/api";
import { useInvalidateWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import type { Campaign } from "@/server/types";
import {
  addFilmScene,
  canDistributeRemainingSeconds,
  canSwitchTargetDirectly,
  createStarterScenes,
  describeFilmDurationMismatch,
  describeFilmPlanSummary,
  describeSceneGaps,
  distributeRemainingSeconds,
  filmDurationState,
  moveFilmScene,
  normalizeFilmDraftScenes,
  removeFilmScene,
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
 * target changes on an untouched starter plan load the new starters
 * directly, while any custom storyboard requires explicit confirmation;
 * aspect changes normalize every draft scene to the plan aspect; add,
 * remove, move, and explicit distribute actions never redistribute time
 * silently; validation runs locally before review. Saving persists the
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
  const [scenes, setScenes] = useState<FilmScene[]>(() =>
    persisted ? normalizeFilmDraftScenes(persisted.scenes, persisted.aspectRatio) : createStarterScenes(30, "9:16")
  );
  const [pendingTarget, setPendingTarget] = useState<FilmTargetDuration | null>(null);
  const [sceneOpError, setSceneOpError] = useState<string | null>(null);
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
  const durationState = useMemo(() => filmDurationState(scenes, target), [scenes, target]);
  const canDistribute = useMemo(() => canDistributeRemainingSeconds(scenes, target), [scenes, target]);
  const distributeBlockedReason =
    durationState.status === "under" && !canDistribute
      ? "Distributing would push a scene over the 15-second maximum - adjust scene durations first."
      : null;

  /**
   * Choosing a total never silently wipes saved or custom work. Only a
   * fresh untouched starter storyboard (no saved plan) switches directly;
   * any edited draft - and any saved plan, even one whose scenes happen to
   * equal the starters - stages a pending target and waits for explicit
   * confirmation. Confirming loads the new starter scenes; cancelling
   * leaves target and scenes untouched. Nothing persists or calls a
   * provider from this confirmation.
   */
  function setTargetDuration(next: FilmTargetDuration) {
    setSceneOpError(null);
    if (next === target) {
      setPendingTarget(null);
      return;
    }
    if (canSwitchTargetDirectly(persisted, scenes, target, aspect)) {
      setTarget(next);
      setScenes(createStarterScenes(next, aspect));
      setSavedNotice(null);
      return;
    }
    setPendingTarget(next);
  }

  function confirmTargetChange() {
    if (pendingTarget === null) return;
    setTarget(pendingTarget);
    setScenes(createStarterScenes(pendingTarget, aspect));
    setPendingTarget(null);
    setSavedNotice(null);
  }

  function cancelTargetChange() {
    setPendingTarget(null);
  }

  function setAspectRatio(next: TemplateFormat) {
    setAspect(next);
    // One aspect ratio per film: every draft scene follows the plan aspect.
    setScenes((prev) => prev.map((s) => ({ ...s, format: next })));
    setSavedNotice(null);
  }

  function updateScene(id: string, patch: Partial<Pick<FilmScene, "title" | "durationSeconds" | "visualDirection" | "sourceIntent">>) {
    setScenes((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    setSavedNotice(null);
  }

  function addScene(): string | null {
    const result = addFilmScene(scenes, aspect);
    setSceneOpError(result.ok ? null : result.error);
    if (!result.ok) return null;
    setScenes(result.scenes);
    setSavedNotice(null);
    return result.scenes[result.scenes.length - 1].id;
  }

  function removeScene(id: string) {
    const result = removeFilmScene(scenes, id);
    setSceneOpError(result.ok ? null : result.error);
    if (result.ok) {
      setScenes(result.scenes);
      setSavedNotice(null);
    }
  }

  function moveScene(id: string, direction: "up" | "down") {
    const result = moveFilmScene(scenes, id, direction);
    setSceneOpError(result.ok ? null : result.error);
    if (result.ok) {
      setScenes(result.scenes);
      setSavedNotice(null);
    }
  }

  function distributeRemaining() {
    const result = distributeRemainingSeconds(scenes, target);
    setSceneOpError(result.ok ? null : result.error);
    if (result.ok) {
      setScenes(result.scenes);
      setSavedNotice(null);
    }
  }

  const canReview = allowed && mode === "campaign_film" && validPlan !== null;

  /**
   * Concise, UI-reachable reasons review is unavailable. The permission lock
   * is reported whenever review is unavailable because of it - even when
   * the plan itself is valid. The list is empty only when the plan is valid
   * and permission is allowed. validateFilmPlan remains the authority
   * (filmError covers anything this list cannot name); the panel shows
   * these instead of a bare disabled button so nothing fails silently.
   */
  const reviewBlockers = useMemo(() => {
    if (mode !== "campaign_film") return [];
    if (validPlan !== null && allowed) return [];
    const blockers: string[] = [];
    if (!allowed) blockers.push("Locked until the permission check passes.");
    if (validPlan !== null) return blockers;
    const trimmedTitle = title.trim();
    if (trimmedTitle === "") blockers.push("Add a film title.");
    else if (trimmedTitle.length > 120) blockers.push("Shorten the film title to 120 characters or fewer.");
    const rawBudget = budget.trim();
    const amount = rawBudget === "" ? NaN : Number(rawBudget);
    if (rawBudget === "") blockers.push("Add a total budget cap in USD.");
    else if (!Number.isFinite(amount) || amount <= 0) blockers.push("Budget cap must be a positive USD amount.");
    for (const s of scenes) {
      const gaps = describeSceneGaps(s);
      if (gaps.length > 0) blockers.push(`Scene ${s.order} needs ${gaps.join(", ")}.`);
    }
    if (
      durationState.status !== "exact" &&
      scenes.every((s) => Number.isInteger(s.durationSeconds))
    ) {
      blockers.push(describeFilmDurationMismatch(durationState.totalSeconds, target));
    }
    if (blockers.length === 0 && filmError) blockers.push(filmError);
    return blockers;
  }, [mode, validPlan, allowed, title, budget, scenes, durationState, target, filmError]);

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
    pendingTarget,
    confirmTargetChange,
    cancelTargetChange,
    aspect,
    setAspectRatio,
    title,
    setTitle,
    budget,
    setBudget,
    scenes,
    updateScene,
    addScene,
    removeScene,
    moveScene,
    distributeRemaining,
    sceneOpError,
    durationState,
    canDistribute,
    distributeBlockedReason,
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
    reviewBlockers,
    openReview,
    confirmSave
  };
}

export type FilmPlanViewModel = ReturnType<typeof useFilmPlan>;
