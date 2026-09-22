"use client";

import { ChevronDown, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ArchivedRecordDangerZoneProps {
  campaignId: string;
  campaignTitle: string;
  warnings: string[];
  forceAllowed: boolean;
  forceReasons: string[];
  forceName: string;
  onForceNameChange: (value: string) => void;
  disabled: boolean;
  onRequestForce: () => void;
}

/**
 * Last resort: permanent removal of an archived record. Deliberately
 * collapsed and type-to-confirm - destroying history must never be a
 * casual click. Display only - the route owns deletion state.
 */
export function ArchivedRecordDangerZone({
  campaignId,
  campaignTitle,
  warnings,
  forceAllowed,
  forceReasons,
  forceName,
  onForceNameChange,
  disabled,
  onRequestForce
}: ArchivedRecordDangerZoneProps) {
  return (
    <details className="group overflow-hidden rounded-2xl border border-border bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-3.5 p-5 [&::-webkit-details-marker]:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-rose-50 ring-1 ring-rose-200 dark:bg-rose-950/50 dark:ring-rose-900">
          <TriangleAlert className="h-4 w-4 text-rose-600 dark:text-rose-300" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold tracking-tight">Delete this archived record</span>
          <span className="mt-0.5 block text-[12.5px] text-muted-foreground">
            Last resort - destroys audit history. This cannot be undone.
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" aria-hidden />
      </summary>
      <div className="space-y-2.5 border-t border-border px-5 py-5">
        <ul className="list-disc space-y-1 pl-5 leading-relaxed text-muted-foreground">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
        {forceAllowed ? (
          <>
            <label htmlFor={`${campaignId}-force-name`} className="block text-[12.5px] text-muted-foreground">
              Type <span className="font-mono text-foreground">{campaignTitle}</span> to enable deletion:
            </label>
            <input
              id={`${campaignId}-force-name`}
              value={forceName}
              onChange={(e) => onForceNameChange(e.target.value)}
              placeholder={campaignTitle}
              autoComplete="off"
              className="w-full max-w-md rounded-xl border border-border bg-background px-3 py-2 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
            />
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={onRequestForce}
                disabled={disabled || forceName !== campaignTitle}
                className="rounded-full border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950/40"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Permanently delete archived record
              </Button>
            </div>
          </>
        ) : (
          <p className="leading-relaxed text-muted-foreground">
            {forceReasons.join(" ") || "Force delete is not available for this record right now."}
          </p>
        )}
      </div>
    </details>
  );
}
