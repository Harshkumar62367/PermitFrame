"use client";

import { ChevronDown, Clapperboard } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FILM_FINISHING_UNAVAILABLE, FILM_TARGET_DURATIONS } from "@/server/livepeer/film-plan";
import type { FilmTargetDuration } from "@/server/livepeer/film-plan";
import type { TemplateFormat } from "@/server/livepeer/template-catalogue";
import type { FilmPlanViewModel } from "./use-film-plan";
import { FilmReviewModal } from "./film-review-modal";
import { FilmRunPanel } from "./film-run-panel";
import type { Campaign } from "@/server/types";

interface FilmPanelProps {
  vm: FilmPlanViewModel;
  allowed: boolean;
  campaignId: string;
  campaign: Campaign;
  onChanged: () => Promise<void>;
}

const FILM_FORMATS: TemplateFormat[] = ["9:16", "4:5", "1:1", "16:9"];
/** 4:5 has no provider film aspect - unselectable in Campaign Film mode (short packs keep it). */
const FILM_DISABLED_FORMATS: TemplateFormat[] = ["4:5"];

/**
 * Campaign film planner (first half: plan + confirm only). Total-duration
 * chips load deterministic starter scenes; every card stays editable;
 * the summary states the separate-shots reality; finishing options render
 * disabled with the muted note. "Review film plan" opens the confirmation
 * modal - confirming only persists the plan, never generates.
 */
export function FilmPanel({ vm, allowed, campaignId, campaign, onChanged }: FilmPanelProps) {
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
                  title={disabled ? "4:5 is not supported for Campaign Film - use 9:16, 1:1, or 16:9" : undefined}
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
            4:5 is not supported for Campaign Film (provider film aspects: 9:16, 1:1, 16:9). 4:5 stays available
            for short image packs.
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
        <p className="text-[12px] font-medium text-muted-foreground">
          Planned scenes · {vm.scenes.length} scenes · {vm.totalSeconds}s of {vm.target}s planned
        </p>
        <ol className="mt-2 space-y-2">
          {vm.scenes.map((scene) => (
            <li key={scene.id} className="rounded-xl border border-border p-3">
              <div className="flex items-baseline justify-between gap-2">
                <p className="min-w-0 truncate text-[13px] font-semibold">
                  <span className="mr-1.5 font-mono text-[11px] text-muted-foreground">Scene {scene.order}</span>
                  {scene.title || <span className="font-normal text-muted-foreground">Untitled beat</span>}
                </p>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{scene.durationSeconds}s</span>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_96px]">
                <label className="block">
                  <span className="text-[11px] font-medium text-muted-foreground">Story beat</span>
                  <input
                    type="text"
                    value={scene.title}
                    maxLength={120}
                    aria-label={`Scene ${scene.order} story beat`}
                    onChange={(e) => vm.updateScene(scene.id, { title: e.target.value })}
                    className="mt-0.5 w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12.5px] focus:border-emerald-500/50 focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] font-medium text-muted-foreground">Seconds (3–15)</span>
                  <input
                    type="number"
                    min={3}
                    max={15}
                    step={1}
                    value={scene.durationSeconds}
                    aria-label={`Scene ${scene.order} duration in seconds`}
                    onChange={(e) => vm.updateScene(scene.id, { durationSeconds: Number(e.target.value) })}
                    className="mt-0.5 w-full rounded-lg border border-border bg-card px-2.5 py-1.5 font-mono text-[12.5px] focus:border-emerald-500/50 focus:outline-none"
                  />
                </label>
              </div>
              <label className="mt-2 block">
                <span className="text-[11px] font-medium text-muted-foreground">Visual direction</span>
                <input
                  type="text"
                  value={scene.visualDirection}
                  aria-label={`Scene ${scene.order} visual direction`}
                  onChange={(e) => vm.updateScene(scene.id, { visualDirection: e.target.value })}
                  className="mt-0.5 w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12.5px] focus:border-emerald-500/50 focus:outline-none"
                />
              </label>
              <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_110px]">
                <label className="block">
                  <span className="text-[11px] font-medium text-muted-foreground">Source / reference intent</span>
                  <input
                    type="text"
                    value={scene.sourceIntent}
                    aria-label={`Scene ${scene.order} source intent`}
                    onChange={(e) => vm.updateScene(scene.id, { sourceIntent: e.target.value })}
                    className="mt-0.5 w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12.5px] focus:border-emerald-500/50 focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] font-medium text-muted-foreground">Format</span>
                  <select
                    value={scene.format}
                    aria-label={`Scene ${scene.order} format`}
                    onChange={(e) => vm.updateScene(scene.id, { format: e.target.value as TemplateFormat })}
                    className="mt-0.5 w-full rounded-lg border border-border bg-card px-2 py-1.5 font-mono text-[12.5px] focus:border-emerald-500/50 focus:outline-none"
                  >
                    {FILM_FORMATS.map((f) => (
                      <option key={f} value={f} disabled={FILM_DISABLED_FORMATS.includes(f)}>
                        {f}{FILM_DISABLED_FORMATS.includes(f) ? " (unsupported)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="rounded-lg bg-muted/60 p-3 ring-1 ring-border">
        <p className="text-[11.5px] font-medium">Finishing</p>
        <div className="mt-1.5 flex flex-wrap gap-2" aria-label="Audio finishing (unavailable)">
          {FILM_FINISHING_UNAVAILABLE.map((kind) => (
            <span
              key={kind}
              aria-disabled="true"
              className="cursor-not-allowed rounded-full px-3 py-1.5 text-[12px] capitalize text-muted-foreground ring-1 ring-border"
            >
              {kind}
            </span>
          ))}
        </div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
          Audio finishing will be added after the film workflow is connected.
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
        {vm.filmError && (
          <p role="alert" className="mt-1.5 break-words text-[12.5px] text-rose-600 dark:text-rose-300">
            {vm.filmError}
          </p>
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
        Pick a total to load its starter scenes, edit each beat, then review and save. Saved plans wait on this
        page - each scene renders later as a separate short shot before final assembly.
      </p>
    </details>
  );
}
