"use client";

import Link from "next/link";
import { ArrowRight, PencilLine } from "lucide-react";
import { CampaignThumbnail } from "./campaign-thumbnail";
import { PolicyDecisionSummary } from "./policy-decision-summary";
import { EvidenceSummary } from "./evidence-summary";
import { campaignOutcome, OutcomeBadge } from "@/components/campaign-outcome";
import type { SnapshotCampaign } from "@/lib/use-workspace-snapshot";
import { displayText } from "@/lib/utils";

function formatUsd(value: number): string {
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * The decision card: a blocked campaign presented as what it is - money not
 * spent because rights or facts said no. All reasons come from the live
 * preflight blockers; nothing is hardcoded.
 */
export function NeedsAttentionPanel({
  campaign,
  overflowCount
}: {
  campaign: SnapshotCampaign;
  overflowCount: number;
}) {
  return (
    <section
      aria-labelledby={`blocked-${campaign.id}`}
      className="flex h-full flex-col overflow-hidden rounded-2xl border border-rose-200 bg-card dark:border-rose-900"
    >
      <div className="border-b border-rose-200/70 bg-rose-50/70 px-5 py-3 dark:border-rose-900 dark:bg-rose-950/30">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-rose-700 dark:text-rose-300">
          Changes needed before creation{overflowCount > 0 && ` · +${overflowCount} more`}
        </p>
      </div>

      <CampaignThumbnail src={campaign.thumbnailUrl} title={displayText(campaign.title)} brand={campaign.brand} />

      <div className="flex flex-1 flex-col p-5">
        <div className="flex flex-wrap items-center gap-2">
          <OutcomeBadge
            outcome={campaignOutcome({
              status: campaign.effectiveStatus,
              decision: campaign.preflight.decision,
              hasOutputs: campaign.receiptsCount > 0,
              publicationStatus: campaign.recordPublicationStatus,
              campaignUAL: campaign.campaignUAL
            })}
          />
          <span className="truncate font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
            {campaign.platform} · {campaign.country}
          </span>
        </div>
        <h3 id={`blocked-${campaign.id}`} className="mt-2.5 text-[17px] font-semibold leading-snug tracking-tight">
          {displayText(campaign.title)}
        </h3>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">
          {campaign.brand} · {campaign.creatorName}
        </p>

        <div className="mt-4">
          <PolicyDecisionSummary preflight={campaign.preflight} />
        </div>

        <div className="mt-4 rounded-xl bg-muted/60 px-3.5 py-2.5 ring-1 ring-border">
          <EvidenceSummary
            knowledgeAssetsConsulted={campaign.preflight.knowledgeAssetsConsulted}
            queriedRights={campaign.preflight.queriedRights}
            queriedFacts={campaign.preflight.queriedFacts}
            checkedAt={campaign.preflight.checkedAt}
            spentLabel={`$0 production spend · ${formatUsd(campaign.estimatedUsd)} prevented`}
          />
        </div>

        <div className="mt-4 flex flex-wrap gap-2 pt-1">
          <Link
            href={`/campaigns/${campaign.id}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-rose-600 px-4 text-[13px] font-medium text-white transition hover:bg-rose-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600"
          >
            Review decision <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
          <Link
            href={`/campaigns/${campaign.id}#simulate`}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border px-4 text-[13px] font-medium text-foreground transition hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
          >
            <PencilLine className="h-3.5 w-3.5" aria-hidden /> Edit request
          </Link>
        </div>
      </div>
    </section>
  );
}
