import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { FadeIn } from "@/components/motion-primitives";
import { EmptyState } from "@/components/ui/empty-state";
import { CampaignCard } from "./campaign-card";
import type { SnapshotCampaign } from "@/lib/use-workspace-snapshot";

/** Presentational campaign section. Data in, no fetching. */
export function CampaignPreviewGrid({ campaigns }: { campaigns: SnapshotCampaign[] }) {
  return (
    <FadeIn subtle>
      <section aria-label="Campaigns">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold tracking-tight">All campaigns</h2>
          <Link href="/campaigns" className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground transition hover:text-foreground">
            Open campaigns <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
        {campaigns.length === 0 ? (
          <EmptyState title="No campaigns yet" body="Brief the first campaign — the permission check verifies rights and claims before anything generates." />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 min-[1500px]:grid-cols-3">
            {campaigns.map((c) => (
              <CampaignCard key={c.id} campaign={c} />
            ))}
          </div>
        )}
      </section>
    </FadeIn>
  );
}
