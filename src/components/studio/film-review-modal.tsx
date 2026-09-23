"use client";

import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import type { FilmPlan } from "@/server/livepeer/film-plan";

interface FilmReviewModalProps {
  open: boolean;
  plan: FilmPlan | null;
  summary: string;
  saving: boolean;
  saveError: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Film plan confirmation: enumerates scene count, total duration, global
 * aspect, and budget cap, then states the exact honesty line before
 * anything is saved. Saving only persists the plan - generation and final
 * assembly have not started. Focuses Cancel first, closes on Escape/backdrop.
 */
export function FilmReviewModal({ open, plan, summary, saving, saveError, onConfirm, onCancel }: FilmReviewModalProps) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onCancel();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      triggerRef.current?.focus?.();
    };
  }, [open, onCancel, saving]);

  if (!open || !plan) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="presentation">
      <div className="absolute inset-0 bg-black/50" onClick={() => !saving && onCancel()} aria-hidden />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl"
      >
        <h2 id={titleId} className="text-[15px] font-semibold tracking-tight">
          Confirm this film plan?
        </h2>
        <p className="mt-1 text-[12.5px] text-muted-foreground">{summary}</p>
        <dl className="mt-4 space-y-2 rounded-xl bg-muted/60 p-4 text-[12.5px] ring-1 ring-border">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Scenes</dt>
            <dd className="font-medium">{plan.scenes.length} planned</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Total duration</dt>
            <dd className="font-mono font-medium">{plan.targetDurationSeconds}s</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Aspect ratio (all scenes)</dt>
            <dd className="font-mono font-medium">{plan.aspectRatio}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Budget cap</dt>
            <dd className="font-mono font-medium">${plan.budgetCapUsd.toFixed(2)}</dd>
          </div>
        </dl>
        <ol className="mt-3 max-h-44 space-y-1 overflow-y-auto text-[12px] leading-relaxed text-muted-foreground">
          {plan.scenes.map((s) => (
            <li key={s.id} className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate">
                <span className="mr-1.5 font-mono text-[10.5px]">{s.order}.</span>
                {s.title}
              </span>
              <span className="shrink-0 font-mono text-[10.5px]">{s.durationSeconds}s</span>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-[12.5px] leading-relaxed text-muted-foreground">
          Generation and final assembly have not started yet. Each scene may be generated separately; final reel
          delivery depends on the provider job succeeding.
        </p>
        {saveError && (
          <p role="alert" className="mt-2 break-words text-[12.5px] text-rose-600 dark:text-rose-300">
            {saveError}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" ref={cancelRef} onClick={onCancel} disabled={saving} className="rounded-full">
            Keep editing
          </Button>
          <Button
            onClick={onConfirm}
            disabled={saving}
            aria-busy={saving}
            className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 disabled:opacity-50 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
          >
            {saving ? "Saving…" : "Save film plan"}
          </Button>
        </div>
      </div>
    </div>
  );
}
