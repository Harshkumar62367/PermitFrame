"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FadeIn } from "@/components/motion-primitives";
import { NewCampaignForm } from "@/components/new-campaign-form";
import { CampaignControlHeader } from "@/components/overview/control-room-header";
import { OperationalMetricsStrip } from "@/components/overview/operational-metrics";
import { NeedsAttentionPanel } from "@/components/overview/needs-attention-panel";
import { ReadyToProducePanel } from "@/components/overview/ready-to-produce-panel";
import { CampaignPipeline } from "@/components/overview/campaign-pipeline";
import { RecentProofActivity } from "@/components/overview/recent-proof-activity";
import { ErrorState } from "@/components/ui/error-state";
import { useWorkspaceOverview } from "@/lib/use-overview";
import { CampaignPreviewGrid } from "@/components/overview/campaign-preview-grid";
import { OverviewLoadingStatus, WorkspaceOverviewSkeleton } from "@/components/overview/workspace-overview-skeleton";
import { cn } from "@/lib/utils";

export default function WorkspaceOverviewPage() {
  const router = useRouter();
  const { status, data, error, retry, refresh } = useWorkspaceOverview();
  const [formOpen, setFormOpen] = useState(false);

  const blocked = (data?.campaigns ?? []).filter((c) => c.effectiveStatus === "blocked");
  const ready = (data?.campaigns ?? []).filter((c) => c.stage === "ready");
  const delivered = (data?.campaigns ?? []).filter((c) => c.stage === "delivered" || c.stage === "generating");
  const attention = blocked[0] ?? null;
  const producible = ready[0] ?? delivered[0] ?? null;
  const attentionOverflow = Math.max(0, blocked.length - 1);

  return (
    <div className="pf-page space-y-6" aria-busy={status === "loading"}>
      <FadeIn subtle>
        <CampaignControlHeader
          workspaceName={data?.workspaceName ?? null}
          formOpen={formOpen}
          onToggleForm={() => setFormOpen((v) => !v)}
        />
      </FadeIn>

      {status === "loading" && (
        <>
          <OverviewLoadingStatus />
          <WorkspaceOverviewSkeleton />
        </>
      )}

      {status === "failed" && <ErrorState message={error ?? "Workspace overview failed to load."} onRetry={retry} />}

      {status === "ready" && data && (
        <>
          {data.warnings.length > 0 && (
            <div className="space-y-2">
              {data.warnings.map((w) => (
                <div
                  key={w.passportId}
                  className={cn(
                    "flex flex-wrap items-center gap-2.5 rounded-xl px-4 py-3 text-[13px] ring-1",
                    w.level === "expired"
                      ? "bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900"
                      : "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900"
                  )}
                >
                  <AlertTriangle className="h-4 w-4" aria-hidden />
                  <span className="font-medium">
                    {w.level === "expired" ? "Rights expired" : `Rights expire in ${w.daysLeft} days`}:
                  </span>
                  <span>
                    {w.creatorName} · passport valid to {w.validUntil}. Renew it on the{" "}
                    <Link href="/consents" className="underline underline-offset-2">Creator permissions page</Link> - expired rights block new permission checks.
                  </span>
                </div>
              ))}
            </div>
          )}

          {formOpen && (
            <FadeIn subtle>
              <NewCampaignForm
                onCreated={(id) => {
                  setFormOpen(false);
                  refresh();
                  router.push(`/campaigns/${id}`);
                }}
              />
            </FadeIn>
          )}

          <OperationalMetricsStrip metrics={data.metrics} />

          {(attention || producible) ? (
            <div className={cn("grid items-stretch gap-4", attention && producible && "lg:grid-cols-2")}>
              {attention ? (
                <NeedsAttentionPanel campaign={attention} overflowCount={attentionOverflow} />
              ) : (
                <AllClearPanel onNewCampaign={() => setFormOpen(true)} />
              )}
              {producible && <ReadyToProducePanel campaign={producible} />}
            </div>
          ) : (
            <FadeIn subtle>
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-dashed border-border bg-card px-5 py-4">
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold tracking-tight">Brief your first campaign</p>
                  <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                    Every request is checked against creator rights and verified brand rules before production spend.
                  </p>
                </div>
                <Button
                  onClick={() => setFormOpen(true)}
                  className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
                >
                  <Plus className="h-4 w-4" aria-hidden /> New campaign
                </Button>
              </div>
            </FadeIn>
          )}

          <CampaignPipeline pipeline={data.pipeline} />

          <RecentProofActivity activity={data.activity} />

          <CampaignPreviewGrid campaigns={data.campaigns} />
        </>
      )}
    </div>
  );
}

/** No blocked campaigns: the left slot explains what "needs attention" means when it appears. */
function AllClearPanel({ onNewCampaign }: { onNewCampaign: () => void }) {
  return (
    <section aria-label="Nothing needs attention" className="flex h-full flex-col justify-center rounded-2xl border border-emerald-200 bg-card p-5 dark:border-emerald-900">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-300">
        All clear
      </p>
      <p className="mt-2 text-[17px] font-semibold tracking-tight">No campaign needs changes right now.</p>
      <p className="mt-1 max-w-md text-[13px] leading-relaxed text-muted-foreground">
        Campaigns that need changes will appear here with the exact failed rules and the production spend that was prevented.
      </p>
      <div className="mt-4">
        <Button
          variant="outline"
          onClick={onNewCampaign}
          className="rounded-full"
        >
          <Plus className="h-4 w-4" aria-hidden /> Brief a campaign
        </Button>
      </div>
    </section>
  );
}
