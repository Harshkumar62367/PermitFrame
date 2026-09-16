"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { FadeIn } from "@/components/motion-primitives";
import { NewCampaignForm } from "@/components/new-campaign-form";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { CampaignCard } from "@/components/overview/campaign-card";
import { useWorkspaceOverview } from "@/lib/use-overview";
import type { SnapshotCampaign } from "@/lib/use-workspace-snapshot";
import { cn } from "@/lib/utils";

type FilterKey = "all" | "attention" | "ready" | "generating" | "delivered" | "briefed";

const FILTERS: { key: FilterKey; label: string; match: (c: SnapshotCampaign) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "attention", label: "Needs attention", match: (c) => c.effectiveStatus === "blocked" },
  { key: "ready", label: "Ready", match: (c) => c.stage === "ready" },
  { key: "generating", label: "Generating", match: (c) => c.stage === "generating" },
  { key: "delivered", label: "Delivered", match: (c) => c.stage === "delivered" },
  { key: "briefed", label: "Briefed", match: (c) => c.stage === "briefed" || c.stage === "policy-check" }
];

function CampaignsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Campaign summaries come from the shared ["workspace-snapshot"] cache, so
  // switching between Overview and Campaigns renders instantly from cache and
  // refreshes quietly in the background. Skeletons only show when no cached
  // data exists at all.
  const { status, data, error, retry } = useWorkspaceOverview();
  const [formOpen, setFormOpen] = useState(false);
  const campaigns = data?.campaigns ?? null;

  const rawFilter = searchParams.get("filter");
  const active: FilterKey = FILTERS.some((f) => f.key === rawFilter) ? (rawFilter as FilterKey) : "all";
  const matcher = FILTERS.find((f) => f.key === active)?.match ?? (() => true);
  const visible = (campaigns ?? []).filter(matcher);

  function setFilter(key: FilterKey) {
    const params = new URLSearchParams(searchParams.toString());
    if (key === "all") params.delete("filter");
    else params.set("filter", key);
    const query = params.toString();
    router.replace(query ? `/campaigns?${query}` : "/campaigns", { scroll: false });
  }

  return (
    <div className="pf-page space-y-6">
      <FadeIn>
        <PageHeader
          eyebrow="Workspace"
          title="Campaigns"
          description="Each request is compiled against rights and facts before generation is allowed."
          actions={
            <Button onClick={() => setFormOpen((v) => !v)} aria-expanded={formOpen} className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400">
              {formOpen ? "Close form" : "New campaign"}
            </Button>
          }
        />
      </FadeIn>

      {formOpen && (
        <FadeIn>
          <NewCampaignForm
            onCreated={(id) => {
              setFormOpen(false);
              // The form already invalidated the snapshot; the cache
              // background-refetches while we navigate to the new campaign.
              retry();
              router.push(`/campaigns/${id}`);
            }}
          />
        </FadeIn>
      )}

      {status === "failed" && (
        <ErrorState message={error ?? "Campaigns failed to load."} onRetry={retry} />
      )}
      {status === "loading" && <LoadingSkeleton rows={3} />}
      {status === "ready" && (
        <>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter campaigns by stage">
            {FILTERS.map((f) => {
              const count = (campaigns ?? []).filter(f.match).length;
              const selected = f.key === active;
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  aria-pressed={selected}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-medium ring-1 transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600",
                    selected
                      ? "bg-foreground text-background ring-foreground dark:bg-white dark:text-black dark:ring-white"
                      : "bg-card text-muted-foreground ring-border hover:text-foreground"
                  )}
                >
                  {f.label}
                  <span className={cn("font-mono text-[11px]", selected ? "opacity-70" : "opacity-60")}>{count}</span>
                </button>
              );
            })}
          </div>
          {visible.length === 0 ? (
            <EmptyState
              title={active === "all" ? "No campaigns yet" : "Nothing in this stage"}
              body={active === "all"
                ? "Create the first request — preflight checks rights and claims before anything generates."
                : "No campaigns currently match this stage. Clear the filter to see everything."}
            />
          ) : (
            <div className="grid items-stretch gap-4 md:grid-cols-2">
              {visible.map((c) => (
                <CampaignCard key={c.id} campaign={c} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function CampaignsPage() {
  return (
    <Suspense fallback={<div className="pf-page"><LoadingSkeleton rows={3} /></div>}>
      <CampaignsContent />
    </Suspense>
  );
}
