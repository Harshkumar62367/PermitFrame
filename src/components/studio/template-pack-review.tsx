"use client";

import { CircleAlert, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SCOPE_TITLES, type TemplatePreview as Preview } from "./template-panel.types";

interface TemplatePackReviewProps {
  allowed: boolean;
  applying: boolean;
  applySlow: boolean;
  previewing: boolean;
  hasChanges: boolean;
  canApply: boolean;
  appliedTitle: string;
  appliedCount: number;
  packTitle: string;
  packSize: string;
  preview: Preview | null;
  previewError: string | null;
  mediaLine: string;
  formatLine: string;
  applyError: string | null;
  formatUsd: (usd: number) => string;
  onPrimary: () => void;
}

/** Pack review plus the single primary action. Display only - no API, no state. */
export function TemplatePackReview({
  allowed,
  applying,
  applySlow,
  previewing,
  hasChanges,
  canApply,
  appliedTitle,
  appliedCount,
  packTitle,
  packSize,
  preview,
  previewError,
  mediaLine,
  formatLine,
  applyError,
  formatUsd,
  onPrimary
}: TemplatePackReviewProps) {
  return (
    <aside aria-label="Pack review" className="min-w-0">
      <div className="rounded-xl bg-muted/60 p-3 ring-1 ring-border" aria-live="polite">
        <p className="text-[13px] font-semibold">Your campaign pack</p>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
          {hasChanges ? `Active plan: ${appliedTitle} · ${appliedCount} stages` : `Active production plan: ${appliedTitle} · ${appliedCount} stages`}
        </p>
        {hasChanges && (
          <p className="mt-0.5 text-[11.5px] font-medium text-emerald-800 dark:text-emerald-200">
            New selection: {packTitle} · {SCOPE_TITLES[packSize] ?? packSize} scope
            {preview ? ` · ${preview.executableCount} assets` : " · estimating…"}
          </p>
        )}
        {previewError && <p role="alert" className="mt-1.5 break-words text-[12.5px] text-rose-600 dark:text-rose-300">{previewError}</p>}
        {!previewError && !preview && (
          <p className="mt-1.5 flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Estimating this pack…
          </p>
        )}
        {preview && (
          <div className="mt-1.5 space-y-1 text-[12.5px] leading-relaxed">
            <p className="font-medium">{packTitle} · {SCOPE_TITLES[packSize] ?? packSize} scope</p>
            <p>{preview.executableCount} ready-to-produce assets · {mediaLine}</p>
            {formatLine && <p className="text-muted-foreground">{formatLine}</p>}
            <p>
              {preview.estimateUsd !== null ? (
                <span title={preview.estimateExact ? "Quoted from live Creative MCP prices" : "Some stages priced from historical rates - treat as an estimate"}>
                  Estimated {formatUsd(preview.estimateUsd)}
                </span>
              ) : (
                "Cost unquotable live"
              )}
              {" · "}about {preview.estimateMinutes} min
            </p>
            <div className="flex flex-wrap gap-1.5 pt-1" aria-label="Included assets">
              {preview.stages.slice(0, 4).map((s) => (
                <span key={s.id} className="rounded-full bg-card px-2 py-0.5 text-[11px] ring-1 ring-border" title={s.label}>
                  {s.label.length > 22 ? `${s.label.slice(0, 22)}…` : s.label}
                </span>
              ))}
              {preview.stages.length > 4 && (
                <span className="rounded-full bg-card px-2 py-0.5 font-mono text-[11px] text-muted-foreground ring-1 ring-border">
                  +{preview.stages.length - 4} more
                </span>
              )}
            </div>
            {preview.deferred.length > 0 && (
              <p className="text-[11.5px] text-muted-foreground">
                Planned, not dispatched: {preview.deferred.map((d) => (d.reason ? `${d.label} (${d.reason})` : d.label)).join(", ")}.
              </p>
            )}
            {preview.stages.some((s) => s.durationAdjusted) && (
              <p role="status" className="break-words text-[11.5px] text-amber-700 dark:text-amber-300">
                {preview.stages.filter((s) => s.durationAdjusted && s.durationNote).map((s) => s.durationNote).join(" ")}
              </p>
            )}
            <details className="pt-1 text-[12px]">
              <summary className="cursor-pointer font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                See all {preview.stages.length} stages
              </summary>
              <ul className="mt-1.5 space-y-1 text-muted-foreground">
                {preview.stages.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate">
                      <span className="mr-1.5 font-mono text-[10px]">{s.format}</span>
                      {s.label}
                      {s.requiredFor.length > 0 && (
                        <span className="ml-1.5 rounded-full bg-sky-100 px-1.5 py-0.5 text-[9.5px] font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-200" title={`Auto-included prerequisite for: ${s.requiredFor.join(", ")}`}>
                          Required for {s.requiredFor.join(", ")}
                        </span>
                      )}
                      <span
                        className="ml-1.5 rounded-full px-1.5 py-0.5 font-mono text-[9.5px] ring-1 ring-border text-muted-foreground"
                        title={s.requestedCapability ? `Pinned model choice: ${s.requestedCapability}` : "Automatic: profile-driven resolution with fallback"}
                      >
                        Model: {s.requestedCapability ?? "Automatic"}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[10.5px]" title={s.durationNote ?? undefined}>
                      {s.durationSeconds ? `${s.durationSeconds}s${s.durationAdjusted && s.requestedDurationSeconds !== null ? ` (was ${s.requestedDurationSeconds}s)` : ""}` : s.capability}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
        {applyError && <p role="alert" className="mt-2 break-words text-[12.5px] text-rose-600 dark:text-rose-300">{applyError}</p>}
        <div className="mt-3">
          <Button
            onClick={onPrimary}
            disabled={!allowed || applying || previewing || !hasChanges || !canApply}
            aria-busy={applying}
            title={!allowed ? "Locked until the permission check passes" : undefined}
            className="w-full rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 disabled:opacity-50 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
          >
            {applying ? (applySlow ? "Still applying…" : "Applying…") : !preview || previewError ? "Review production plan" : hasChanges ? "Apply new production plan" : "This plan is already active"}
          </Button>
          <p className="mt-1.5 text-center text-[10.5px] leading-snug text-muted-foreground">
            {applying && applySlow
              ? "Still working through the approved rights check and live costs. This can take a while - the plan lands on its own."
              : "Applying rebuilds this plan through the approved rights check."}
          </p>
        </div>
        {!allowed && (
          <p className="mt-2 flex items-start gap-1.5 text-[12px] text-rose-600 dark:text-rose-300">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Locked - resolve the rights block first.
          </p>
        )}
      </div>
    </aside>
  );
}
