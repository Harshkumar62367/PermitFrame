"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { campaignOutcome, OutcomeBadge } from "@/components/campaign-outcome";
import { cn, displayText } from "@/lib/utils";
import type { Campaign, PermissionPassport, SourceMedia } from "@/server/types";

interface StudioHeaderProps {
  campaign: Campaign;
  sourceMedia: SourceMedia | null;
  passport: PermissionPassport | null;
  busy: boolean;
  onRecheck: () => void;
}

/**
 * Studio header: campaign name, objective, approval status, selected
 * creator/source and platforms. Re-check keeps the verdict live - rights
 * may have changed since approval.
 */
export function StudioHeader({ campaign, sourceMedia, passport, busy, onRecheck }: StudioHeaderProps) {
  const objective = displayText(campaign.request.objective?.trim() || campaign.title);
  const outcome = campaignOutcome({
    status: campaign.status,
    decision: campaign.preflight?.decision ?? null,
    hasOutputs: campaign.receipts.length > 0,
    publicationStatus: campaign.publicationStatus,
    campaignUAL: campaign.campaignUAL
  });
  return (
    <div className="rounded-2xl border border-emerald-200 bg-gradient-to-b from-emerald-50/80 to-card p-5 sm:p-6 dark:border-emerald-900 dark:from-emerald-950/40">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-2xl">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-300">
            Creative Studio · {outcome.label}
          </p>
          <h2 className="font-display mt-1.5 text-balance text-2xl font-semibold tracking-tight">{displayText(campaign.title)}</h2>
          {objective !== displayText(campaign.title) && (
            <p className="mt-1 text-[13.5px] text-muted-foreground">{objective}</p>
          )}
          {outcome.explanation && (
            <p className="mt-1 text-[12.5px] text-muted-foreground">{outcome.explanation}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <OutcomeBadge outcome={outcome} />
            </span>
            <span>
              Creator <span className="font-medium text-foreground">{passport?.creatorName ?? campaign.creatorId}</span>
            </span>
            <span>
              Source <span className="font-medium text-foreground">{sourceMedia?.title ?? campaign.sourceMediaId}</span>
            </span>
            <span className="font-mono text-[11px] uppercase tracking-[0.1em]">
              {campaign.request.platform} · {campaign.request.country} · {campaign.request.transformation} pack
            </span>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRecheck}
          disabled={busy}
          aria-busy={busy}
          className="shrink-0 rounded-full"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} aria-hidden />
          {busy ? "Checking permissions…" : "Check permissions again"}
        </Button>
      </div>
    </div>
  );
}
