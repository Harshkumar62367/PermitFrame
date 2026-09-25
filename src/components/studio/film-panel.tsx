"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Clapperboard } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FILM_MAX_SCENES, FILM_MIN_SCENES, FILM_PLAN_UNSUPPORTED_FINISHING, FILM_TARGET_DURATIONS } from "@/server/livepeer/film-plan";
import type { FilmFinishingKind, FilmTargetDuration } from "@/server/livepeer/film-plan";
import type { TemplateFormat } from "@/server/livepeer/template-catalogue";
import type { FilmPlanViewModel } from "./use-film-plan";
import { FilmReviewModal } from "./film-review-modal";
import { FilmRunPanel } from "./film-run-panel";
import { FilmSceneCard } from "./film-scene-card";
import type { Campaign } from "@/server/types";

interface FilmPanelProps {
  vm: FilmPlanViewModel;
  allowed: boolean;
  campaignId: string;
  campaign: Campaign;
  onChanged: () => Promise<void>;
}

// All visible film choices are provider-supported; anything else is blocked
// server-side before any provider request. New users are only ever offered
// supported aspects.
const FILM_FORMATS: TemplateFormat[] = ["9:16", "1:1", "16:9"];
const FILM_DISABLED_FORMATS: TemplateFormat[] = [];

/**
 * Campaign film planner (first half: plan + confirm only). Total-duration
 * chips load deterministic starter scenes on untouched plans and ask for
 * explicit confirmation on custom or saved storyboards; one plan-level
 * aspect applies to every scene. The storyboard below is compact by
 * default - one scene editor open at a time - with safe add, remove, and
 * reorder actions; the summary states the separate-shots reality;
 * finishing renders as non-interactive availability labels
 * (post-delivery vs not-available-yet). "Review film plan" opens the
 * confirmation modal - confirming only persists the plan, never generates.
 */
export function FilmPanel({ vm, allowed, campaignId, campaign, onChanged }: FilmPanelProps) {
  // UI-local only: which scene editor is open. Draft state stays in the vm.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const headingRefs = useRef(new Map<string, HTMLHeadingElement>());

  // Never render a dangling editor (e.g. after a confirmed target switch
  // replaces the scenes): fall back to fully collapsed.
  const activeId = vm.scenes.some((s) => s.id === expandedId) ? expandedId : null;

  // Move focus into the editor heading whenever a scene opens - ref +
  // effect only, no timeouts. The Edit button already holds focus on
  // manual toggle; this announces the new editing context.
  useEffect(() => {
    if (activeId) headingRefs.current.get(activeId)?.focus();
  }, [activeId]);

  function toggleScene(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  function handleAddScene() {
    const id = vm.addScene();
    // addScene returns the new scene id, or null when refused (at maximum).
    if (id) setExpandedId(id);
  }

  function handleConfirmTargetChange() {
    // Starter ids repeat across targets (film-scene-1, ...), so an old
    // expanded id can still exist in the replacement storyboard - collapse
    // explicitly instead of relying on the dangling-id guard.
    setExpandedId(null);
    vm.confirmTargetChange();
  }

  function handleRemoveScene(id: string) {
    const at = vm.scenes.findIndex((s) => s.id === id);
    vm.removeScene(id);
    // Removal below the minimum is refused with no mutation; otherwise
    // expand the nearest remaining scene so focus never dangles.
    if (id === expandedId && at !== -1 && vm.scenes.length > FILM_MIN_SCENES) {
      const rest = vm.scenes.filter((s) => s.id !== id);
      const next = rest[Math.min(at, rest.length - 1)];
      setExpandedId(next ? next.id : null);
    }
  }

  function registerHeading(id: string) {
    return (el: HTMLHeadingElement | null) => {
      if (el) headingRefs.current.set(id, el);
      else headingRefs.current.delete(id);
    };
  }
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border p-4">
        <p className="text-[12px] font-medium text-muted-foreground">Total duration</p>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
          One reel total, planned as separate short scenes - never one long render.
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Film total duration">
          {FILM_TARGET_DURATIONS.map((s: FilmTargetDuration) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={vm.target === s}
              onClick={() => vm.setTargetDuration(s)}
              className={cn(
                "rounded-lg px-2.5 py-1.5 font-mono text-[12px] ring-1 transition",
                vm.target === s
                  ? "bg-emerald-600 text-white ring-emerald-600 dark:bg-emerald-500 dark:text-emerald-950"
                  : "bg-card text-muted-foreground ring-border hover:ring-emerald-600/40"
              )}
            >
              {s}s
            </button>
          ))}
        </div>
        {vm.pendingTarget !== null && (
          <div role="alertdialog" aria-label="Confirm storyboard replacement" className="mt-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="text-[12.5px] leading-relaxed">
              Changing total duration replaces this storyboard with the new starter scenes. Unsaved scene edits will
              be discarded.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={handleConfirmTargetChange}
                className="rounded-full bg-amber-600 font-medium text-white hover:bg-amber-500"
              >
                Replace storyboard
              </Button>
              <Button type="button" variant="outline" onClick={() => vm.cancelTargetChange()} className="rounded-full">
                Keep editing
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`film-title-${campaignId}`} className="text-[12px] font-medium text-muted-foreground">
            Film title
          </label>
          <input
            id={`film-title-${campaignId}`}
            type="text"
            value={vm.title}
            maxLength={120}
            placeholder="e.g. Autumn launch reel"
            onChange={(e) => vm.setTitle(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] focus:border-emerald-500/50 focus:outline-none"
          />
        </div>
        <div>
          <p className="text-[12px] font-medium text-muted-foreground">Aspect ratio</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Film aspect ratio">
            {FILM_FORMATS.map((f) => {
              const disabled = FILM_DISABLED_FORMATS.includes(f);
              return (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={vm.aspect === f}
                  aria-label={`Film format ${f}${disabled ? " (not supported for Campaign Film)" : ""}`}
                  aria-disabled={disabled}
                  disabled={disabled}
                  title={disabled ? "This format is not supported for Campaign Film" : undefined}
                  onClick={() => vm.setAspectRatio(f)}
                  className={cn(
                    "rounded-full px-3 py-1.5 font-mono text-[12px] ring-1 transition",
                    disabled
                      ? "cursor-not-allowed bg-muted text-muted-foreground/60 line-through ring-border"
                      : vm.aspect === f
                        ? "bg-emerald-600/10 text-emerald-800 ring-emerald-600/40 dark:text-emerald-200"
                        : "bg-card text-muted-foreground ring-border hover:ring-emerald-600/40"
                  )}
                >
                  {f}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
            One aspect ratio per Campaign Film - every scene uses this aspect; there is no per-scene format. Provider
            film aspects are 9:16, 1:1, and 16:9. Short image packs also offer 4:3.
          </p>
        </div>
      </div>

      <div>
        <label htmlFor={`film-cap-${campaignId}`} className="text-[12px] font-medium text-muted-foreground">
          Total budget cap (USD, required)
        </label>
        <input
          id={`film-cap-${campaignId}`}
          type="number"
          min={0.1}
          step={0.5}
          value={vm.budget}
          placeholder="e.g. 25"
          onChange={(e) => vm.setBudget(e.target.value)}
          className="mt-1.5 w-full max-w-60 rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] focus:border-emerald-500/50 focus:outline-none"
        />
      </div>

      <div>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-muted-foreground">
              Storyboard · {vm.scenes.length} scenes · {vm.totalSeconds}s of {vm.target}s planned
              {vm.durationState.status === "exact"
                ? " · matches the target exactly"
                : vm.durationState.status === "under"
                  ? ` · under by ${vm.durationState.differenceSeconds} ${vm.durationState.differenceSeconds === 1 ? "second" : "seconds"}`
                  : ` · over by ${vm.durationState.differenceSeconds} ${vm.durationState.differenceSeconds === 1 ? "second" : "seconds"} - reduce scene durations to match`}
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              Each scene renders later as a separate short shot - never one long render. Edit one scene at a time.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={handleAddScene}
            disabled={vm.scenes.length >= FILM_MAX_SCENES}
            title={vm.scenes.length >= FILM_MAX_SCENES ? `Campaign films hold at most ${FILM_MAX_SCENES} planned scenes.` : undefined}
            className="shrink-0 rounded-full"
          >
            Add scene
          </Button>
        </div>
        <p className="mt-1 text-[11.5px] text-muted-foreground">
          New scenes start at 3 seconds with empty fields - fill every beat before review. Removing never
          redistributes time.
        </p>
        {vm.durationState.status === "under" && (
          <div className="mt-1.5">
            <Button
              type="button"
              variant="outline"
              onClick={() => vm.distributeRemaining()}
              disabled={!vm.canDistribute}
              title={vm.distributeBlockedReason ?? undefined}
              className="rounded-full"
            >
              Distribute remaining {vm.durationState.differenceSeconds} {vm.durationState.differenceSeconds === 1 ? "second" : "seconds"}
            </Button>
            {vm.distributeBlockedReason && (
              <p className="mt-1 text-[11.5px] text-muted-foreground">{vm.distributeBlockedReason}</p>
            )}
          </div>
        )}
        <ol className="mt-2 space-y-2" aria-label="Campaign film storyboard">
          {vm.scenes.map((scene, index) => (
            <FilmSceneCard
              key={scene.id}
              scene={scene}
              index={index}
              isLast={index === vm.scenes.length - 1}
              expanded={scene.id === activeId}
              panelId={`film-scene-editor-${campaignId}-${scene.id}`}
              headingId={`film-scene-editor-heading-${campaignId}-${scene.id}`}
              registerHeading={registerHeading(scene.id)}
              onToggle={toggleScene}
              onPatch={vm.updateScene}
              onMove={vm.moveScene}
              onRemove={handleRemoveScene}
            />
          ))}
        </ol>
        {vm.sceneOpError && (
          <p role="alert" className="mt-1.5 break-words text-[12.5px] text-rose-600 dark:text-rose-300">
            {vm.sceneOpError}
          </p>
        )}
      </div>

      <div className="rounded-lg bg-muted/60 p-3 ring-1 ring-border">
        <p className="text-[11.5px] font-medium">Finishing</p>
        <div className="mt-1.5 flex flex-wrap gap-2" aria-label="Finishing availability (plan only)">
          {FILM_PLAN_UNSUPPORTED_FINISHING.map((kind: FilmFinishingKind) => (
            <span
              key={kind}
              aria-disabled="true"
              className="cursor-not-allowed rounded-full px-3 py-1.5 text-[12px] text-muted-foreground ring-1 ring-border"
            >
              {kind === "narration"
                ? "Narration - after delivery"
                : kind === "subtitles"
                  ? "Burned captions - after delivery"
                  : "Music - not available yet"}
            </span>
          ))}
        </div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
          Narration and burned captions are available only after a reel is delivered. Music and soundtrack mixing are not available yet.
        </p>
      </div>

      <div className="rounded-xl bg-muted/60 p-3 ring-1 ring-border" aria-live="polite">
        <p className="flex items-start gap-2 text-[13px] font-semibold">
          <Clapperboard className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {vm.summary}
        </p>
        {vm.persisted && (
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            Saved plan: {vm.persisted.title} · {vm.persisted.targetDurationSeconds}s · {vm.persisted.scenes.length} scenes.
          </p>
        )}
        {!vm.canReview && vm.reviewBlockers.length > 0 && (
          <div role="alert" className="mt-1.5 rounded-lg bg-rose-500/10 p-2.5 ring-1 ring-rose-500/30">
            <p className="text-[12px] font-medium text-rose-700 dark:text-rose-200">Before review:</p>
            <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-[12px] leading-snug text-rose-700 dark:text-rose-200">
              {vm.reviewBlockers.map((blocker) => (
                <li key={blocker} className="break-words">
                  {blocker}
                </li>
              ))}
            </ul>
          </div>
        )}
        {vm.savedNotice && !vm.filmError && (
          <p role="status" className="mt-1.5 text-[12.5px] text-emerald-800 dark:text-emerald-200">
            {vm.savedNotice}
          </p>
        )}
        {vm.reviewError && (
          <p role="alert" className="mt-1.5 break-words text-[12.5px] text-rose-600 dark:text-rose-300">
            {vm.reviewError}
          </p>
        )}
        <div className="mt-3">
          <Button
            onClick={() => void vm.openReview()}
            disabled={!allowed || !vm.canReview || vm.reviewing}
            aria-busy={vm.reviewing}
            title={!allowed ? "Locked until the permission check passes" : undefined}
            className="w-full rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 disabled:opacity-50 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
          >
            {vm.reviewing ? "Reviewing…" : "Review film plan"}
          </Button>
          <p className="mt-1.5 text-center text-[10.5px] leading-snug text-muted-foreground">
            Reviewing checks the plan on the server - saving stores it, generation stays off.
          </p>
          <FilmDetails />
        </div>
      </div>

      <FilmReviewModal
        open={vm.reviewOpen}
        plan={vm.validPlan}
        summary={vm.summary}
        saving={vm.saving}
        saveError={vm.saveError}
        onConfirm={() => void vm.confirmSave()}
        onCancel={() => vm.setReviewOpen(false)}
      />

      <FilmRunPanel campaign={campaign} allowed={allowed} onChanged={onChanged} />
    </div>
  );
}

function FilmDetails() {
  return (
    <details className="mt-2 text-[12px]">
      <summary className="cursor-pointer font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
        <span className="inline-flex items-center gap-1">
          How film planning works <ChevronDown className="h-3 w-3" aria-hidden />
        </span>
      </summary>
      <p className="mt-1.5 leading-relaxed text-muted-foreground">
        Pick a total for its starter scenes (a custom storyboard asks before replacing), edit each beat, then review
        and save. One plan-level aspect applies to every scene. Saved plans wait on this page - each scene renders
        later as a separate short shot before final assembly.
      </p>
    </details>
  );
}
