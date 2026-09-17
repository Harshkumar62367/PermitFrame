"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CampaignThumbnail } from "./campaign-thumbnail";
import { PolicyResultLine } from "./policy-decision-summary";
import { campaignOutcome, OutcomeBadge } from "@/components/campaign-outcome";
import type { SnapshotCampaign } from "@/lib/use-workspace-snapshot";
import { cn } from "@/lib/utils";

const STAGE_LABEL: Record<SnapshotCampaign["stage"], string> = {
  briefed: "Briefed",
  "policy-check": "Permission check",
  ready: "Ready",
  generating: "Generating",
  delivered: "Delivered"
};

function nextActionFor(campaign: SnapshotCampaign): string {
  if (campaign.effectiveStatus === "blocked") return "Review decision";
  if (campaign.activeJobs > 0) return "Track production";
  if (campaign.stage === "ready") return "Generate pack";
  if (campaign.receiptsCount > 0) return "Open pack";
  if (campaign.preflight.decision === "pending") return "Run permission check";
  return "Open campaign";
}

/**
 * Reusable campaign card: visual thumbnail, corrected status + stage badges,
 * one-line rights-check result, next action. Blocked, ready and generated
 * campaigns read differently without changing the layout.
 */
export function CampaignCard({ campaign }: { campaign: SnapshotCampaign }) {
  const blocked = campaign.effectiveStatus === "blocked";
  const outcome = campaignOutcome({
    status: campaign.effectiveStatus,
    decision: campaign.preflight.decision,
    hasOutputs: campaign.receiptsCount > 0,
    publicationStatus: campaign.recordPublicationStatus,
    campaignUAL: campaign.campaignUAL
  });
  return (
    <Link
      href={`/campaigns/${campaign.id}`}
      className={cn(
        "group flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card transition-all duration-300 hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600",
        blocked
          ? "hover:border-rose-600/40 hover:shadow-[0_12px_40px_-16px_rgba(244,63,94,0.25)]"
          : "hover:border-emerald-600/30 hover:shadow-[0_12px_40px_-16px_rgba(16,185,129,0.2)]"
      )}
    >
      <CampaignThumbnail src={campaign.thumbnailUrl} title={campaign.title} brand={campaign.brand} />
      <span className="flex flex-1 flex-col p-5">
        <span className="flex flex-wrap items-center gap-2">
          <OutcomeBadge outcome={outcome} />
          <span className="rounded-full bg-secondary px-2.5 py-0.5 text-[11px] font-medium text-secondary-foreground">
            {STAGE_LABEL[campaign.stage]}
          </span>
          <span className="ml-auto truncate font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
            {campaign.platform} · {campaign.country}
          </span>
        </span>
        <span className="mt-3 block text-[15px] font-semibold leading-snug tracking-tight">{campaign.title}</span>
        <span className="mt-0.5 block text-[12px] text-muted-foreground">
          {campaign.brand} · {campaign.creatorName}
        </span>
        <PolicyResultLine preflight={campaign.preflight} className="mt-2 line-clamp-2 text-[12.5px] leading-relaxed" />
        <span className="mt-3 flex items-center justify-between gap-2 border-t border-border/70 pt-3">
          <time dateTime={campaign.updatedAt} className="truncate text-[11.5px] text-muted-foreground" title={new Date(campaign.updatedAt).toLocaleString()}>
            Updated {new Date(campaign.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </time>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 text-[12px] font-medium",
              blocked
                ? "text-rose-700 dark:text-rose-300"
                : "text-emerald-700 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100 dark:text-emerald-300"
            )}
          >
            {nextActionFor(campaign)} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </span>
        </span>
      </span>
    </Link>
  );
}
