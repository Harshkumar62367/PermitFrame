"use client";

import { useEffect, useId, useRef } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Accessible confirmation dialog for destructive actions (e.g. passport
 * revocation). States the consequence, focuses Cancel first, closes on
 * Escape/backdrop, returns focus to the trigger.
 */
export function ConfirmDialog({
  open,
  title,
  consequence,
  confirmLabel,
  cancelLabel = "Keep as is",
  pending = false,
  pendingLabel = "Working…",
  onConfirm,
  onCancel
}: {
  open: boolean;
  title: string;
  consequence: string;
  confirmLabel: string;
  cancelLabel?: string;
  pending?: boolean;
  pendingLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onCancel();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      triggerRef.current?.focus?.();
    };
  }, [open, onCancel, pending]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="presentation">
      <div className="absolute inset-0 bg-black/50" onClick={() => !pending && onCancel()} aria-hidden />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="relative w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-rose-50 ring-1 ring-rose-200 dark:bg-rose-950/50 dark:ring-rose-900">
            <TriangleAlert className="h-4 w-4 text-rose-600 dark:text-rose-300" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-balance text-[15px] font-semibold tracking-tight">
              {title}
            </h2>
            <p id={bodyId} className="mt-1.5 text-pretty text-[13px] leading-relaxed text-muted-foreground">
              {consequence}
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button ref={cancelRef} variant="outline" onClick={onCancel} disabled={pending} className="rounded-full">
            {cancelLabel}
          </Button>
          <Button
            onClick={onConfirm}
            disabled={pending}
            aria-busy={pending}
            className="rounded-full bg-rose-600 font-medium text-white hover:bg-rose-500 dark:bg-rose-500 dark:text-rose-950 dark:hover:bg-rose-400"
          >
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
