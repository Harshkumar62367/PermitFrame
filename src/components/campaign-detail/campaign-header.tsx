import { FadeIn } from "@/components/motion-primitives";
import { campaignOutcome, OutcomeBadge } from "@/components/campaign-outcome";
import { cn, displayText } from "@/lib/utils";
import type { Campaign, PermissionPassport, ProductFacts, SourceMedia } from "@/server/types";

interface CampaignHeaderProps {
  campaign: Campaign;
  sourceMedia: SourceMedia | null;
  passport: PermissionPassport | null;
  productFacts: ProductFacts | null;
}

/** The campaign identity and its rights inputs. Kept presentational so the
 * route owns all mutations while this stays easy to reuse and test. */
export function CampaignHeader({ campaign, sourceMedia, passport, productFacts }: CampaignHeaderProps) {
  const outcome = campaignOutcome({
    status: campaign.status,
    decision: campaign.preflight?.decision ?? null,
    hasOutputs: campaign.receipts.length > 0,
    publicationStatus: campaign.publicationStatus,
    campaignUAL: campaign.campaignUAL
  });

  return (
    <FadeIn>
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0 max-w-2xl">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-balance text-3xl font-semibold tracking-tight">{displayText(campaign.title)}</h1>
            <OutcomeBadge outcome={outcome} />
          </div>
          {outcome.explanation && <p className="mt-1.5 text-[13px] text-muted-foreground">{outcome.explanation}</p>}
          <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            {campaign.brand} {campaign.productName} · {campaign.request.platform} · {campaign.request.country} · {campaign.request.transformation} pack
          </p>
          <p className="mt-3 text-[14px] italic leading-relaxed text-muted-foreground">“{displayText(campaign.request.creativeBrief)}”</p>
        </div>
        {sourceMedia && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={sourceMedia.url} alt="source media" className="h-30 w-24 shrink-0 rounded-xl object-cover ring-1 ring-border" />
        )}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Chip label="claims requested" value={campaign.request.requestedClaims.join(", ") || "-"} />
        <Chip label="passport" value={passport?.id ?? "-"} mono />
        <Chip label="facts" value={productFacts?.id ?? "-"} mono />
      </div>
    </FadeIn>
  );
}

function Chip({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-[11.5px] ring-1 ring-border">
      <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
      <span className={cn("pf-id text-foreground/80", mono && "font-mono text-[11px]")} title={value}>{value}</span>
    </span>
  );
}
