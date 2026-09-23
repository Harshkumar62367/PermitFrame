"use client";

import { cn } from "@/lib/utils";
import { describeSceneGaps, type FilmScene } from "@/server/livepeer/film-plan";

type ScenePatch = Partial<Pick<FilmScene, "title" | "durationSeconds" | "visualDirection" | "sourceIntent">>;

interface FilmSceneCardProps {
  scene: FilmScene;
  index: number;
  isLast: boolean;
  expanded: boolean;
  /** Stable editor panel id, owned by the parent for aria-controls. */
  panelId: string;
  /** Stable heading id for the expanded panel's aria-labelledby. */
  headingId: string;
  registerHeading: (el: HTMLHeadingElement | null) => void;
  onToggle: (id: string) => void;
  onPatch: (id: string, patch: ScenePatch) => void;
  onMove: (id: string, direction: "up" | "down") => void;
  onRemove: (id: string) => void;
}

const ACTION_RING =
  "rounded-full px-2.5 py-1 text-[11.5px] ring-1 ring-border transition hover:ring-emerald-600/40 disabled:cursor-not-allowed disabled:opacity-40";

/**
 * One storyboard scene: a compact status row by default, a full editor when
 * expanded. Presentational only - all draft state lives in useFilmPlan; the
 * parent owns which card is expanded. Per-scene completeness comes from the
 * pure describeSceneGaps helper, so collapsed rows still name missing work.
 */
export function FilmSceneCard({
  scene,
  index,
  isLast,
  expanded,
  panelId,
  headingId,
  registerHeading,
  onToggle,
  onPatch,
  onMove,
  onRemove
}: FilmSceneCardProps) {
  const gaps = describeSceneGaps(scene);
  const beat = scene.title.trim() === "" ? null : scene.title;
  const editLabel = expanded ? `Collapse scene ${scene.order}` : `Edit scene ${scene.order}${beat ? `: ${beat}` : ""}`;

  return (
    <li className="rounded-xl border border-border">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 p-3">
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">Scene {scene.order}</span>
        <p className="min-w-0 flex-1 basis-24 truncate text-[13px] font-semibold">
          {beat ?? <span className="font-normal text-muted-foreground">Untitled beat</span>}
        </p>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{scene.durationSeconds}s</span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium ring-1",
            gaps.length === 0
              ? "bg-emerald-600/10 text-emerald-800 ring-emerald-600/40 dark:text-emerald-200"
              : "bg-amber-500/10 text-amber-800 ring-amber-500/40 dark:text-amber-200"
          )}
        >
          {gaps.length === 0 ? "Ready to review" : "Needs details"}
        </span>
        <button
          type="button"
          onClick={() => onToggle(scene.id)}
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={editLabel}
          className="shrink-0 rounded-full bg-emerald-700 px-3 py-1 text-[11.5px] font-medium text-emerald-50 transition hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
        >
          {expanded ? "Collapse" : "Edit"}
        </button>
      </div>
      {gaps.length > 0 && (
        <p className="px-3 pb-2 text-[11.5px] leading-snug text-amber-800 dark:text-amber-200">
          Needs {gaps.join(", ")}
        </p>
      )}
      {expanded && (
        <div id={panelId} role="region" aria-labelledby={headingId} className="border-t border-border p-3">
          <h4 ref={registerHeading} id={headingId} tabIndex={-1} className="text-[13px] font-semibold outline-none">
            Scene {scene.order} editor{beat ? ` · ${beat}` : ""}
          </h4>
          <div className="mt-1.5 flex flex-wrap gap-1.5" aria-label={`Scene ${scene.order} storyboard actions`}>
            <button
              type="button"
              onClick={() => onMove(scene.id, "up")}
              disabled={index === 0}
              aria-label={`Move scene ${scene.order} up`}
              className={ACTION_RING}
            >
              Move up
            </button>
            <button
              type="button"
              onClick={() => onMove(scene.id, "down")}
              disabled={isLast}
              aria-label={`Move scene ${scene.order} down`}
              className={ACTION_RING}
            >
              Move down
            </button>
            <button
              type="button"
              onClick={() => onRemove(scene.id)}
              aria-label={`Remove scene ${scene.order}`}
              className="rounded-full px-2.5 py-1 text-[11.5px] text-rose-600 ring-1 ring-border transition hover:ring-rose-600/40 dark:text-rose-300"
            >
              Remove
            </button>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_96px]">
            <label className="block">
              <span className="text-[11px] font-medium text-muted-foreground">Story beat</span>
              <input
                type="text"
                value={scene.title}
                maxLength={120}
                aria-label={`Scene ${scene.order} story beat`}
                onChange={(e) => onPatch(scene.id, { title: e.target.value })}
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
                onChange={(e) => onPatch(scene.id, { durationSeconds: Number(e.target.value) })}
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
              onChange={(e) => onPatch(scene.id, { visualDirection: e.target.value })}
              className="mt-0.5 w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12.5px] focus:border-emerald-500/50 focus:outline-none"
            />
          </label>
          <label className="mt-2 block">
            <span className="text-[11px] font-medium text-muted-foreground">Scene direction note</span>
            <input
              type="text"
              value={scene.sourceIntent}
              aria-label={`Scene ${scene.order} direction note`}
              onChange={(e) => onPatch(scene.id, { sourceIntent: e.target.value })}
              className="mt-0.5 w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12.5px] focus:border-emerald-500/50 focus:outline-none"
            />
            <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
              This guides the render as text. It does not attach or preserve source media.
            </span>
          </label>
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={() => onToggle(scene.id)}
              aria-label={`Done editing scene ${scene.order}`}
              className="rounded-full px-3 py-1 text-[11.5px] font-medium ring-1 ring-border transition hover:ring-emerald-600/40"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
