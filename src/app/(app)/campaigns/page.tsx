"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { CheckCircle2, X } from "lucide-react";
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
import { DEMO_BOUNDARY_NOTICE, demoPrefillFor, getDemoCampaign } from "@/lib/demo-campaigns";
import { cn } from "@/lib/utils";

type FilterKey = "all" | "attention" | "ready" | "generating" | "delivered" | "briefed" | "archived";

const FILTERS: { key: FilterKey; label: string; match: (c: SnapshotCampaign) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "attention", label: "Needs attention", match: (c) => c.effectiveStatus === "blocked" },
  { key: "ready", label: "Ready", match: (c) => c.stage === "ready" },
  { key: "generating", label: "Generating", match: (c) => c.stage === "generating" },
  { key: "delivered", label: "Delivered", match: (c) => c.stage === "delivered" },
  { key: "briefed", label: "Briefed", match: (c) => c.stage === "briefed" || c.stage === "policy-check" },
  { key: "archived", label: "Archived", match: () => true }
];

function CampaignsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Campaign summaries come from the shared ["workspace-snapshot"] cache, so
  // switching between Campaigns and other pages renders instantly from cache
  // and refreshes quietly in the background. Skeletons only show when no
  // cached data exists at all.
  const { status, data, error, retry } = useWorkspaceOverview();
  const [formOpen, setFormOpen] = useState(false);
  const campaigns = data?.campaigns ?? null;
  const archived = data?.archivedCampaigns ?? [];

  const rawFilter = searchParams.get("filter");
  const deletedTitle = searchParams.get("deleted");
  // Demo-brief entry (?demo=<id>): resolves against local definitions only.
  // Unknown ids fail closed to no banner; the prefill below carries only
  // the allow-listed brief fields, and permission/media/brand rule still
  // start empty behind their unchanged gates.
  const demo = searchParams.get("demo") ? getDemoCampaign(searchParams.get("demo") as string) : undefined;
  const [demoPrefill, setDemoPrefill] = useState<{ title: string; platform: string; creativeBrief: string } | null>(null);
  const active: FilterKey = FILTERS.some((f) => f.key === rawFilter) ? (rawFilter as FilterKey) : "all";
  const matcher = FILTERS.find((f) => f.key === active)?.match ?? (() => true);
  // Archived rows live outside the normal lists by design; the Archived
  // filter is their only in-product discovery (besides direct links).
  const pool = active === "archived" ? archived : (campaigns ?? []);
  const visible = pool.filter(matcher);
  const countFor = (key: FilterKey) =>
    key === "archived" ? archived.length : (campaigns ?? []).filter(FILTERS.find((f) => f.key === key)?.match ?? (() => true)).length;

  function setFilter(key: FilterKey) {
    const params = new URLSearchParams(searchParams.toString());
    if (key === "all") params.delete("filter");
    else params.set("filter", key);
    const query = params.toString();
    router.replace(query ? `/campaigns?${query}` : "/campaigns", { scroll: false });
  }

  function dismissDeleted() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("deleted");
    const query = params.toString();
    router.replace(query ? `/campaigns?${query}` : "/campaigns", { scroll: false });
  }

  function dismissDemo() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("demo");
    const query = params.toString();
    setDemoPrefill(null);
    router.replace(query ? `/campaigns?${query}` : "/campaigns", { scroll: false });
  }

  function startFromDemoBrief() {
    if (!demo) return;
    const prefill = demoPrefillFor(demo.id);
    if (!prefill) return;
    setDemoPrefill({ title: prefill.title, platform: prefill.platform, creativeBrief: prefill.brief });
    setFormOpen(true);
  }

  return (
    <div className="pf-page space-y-6">
      <FadeIn>
        <PageHeader
          eyebrow="Campaigns"
          title="Campaigns"
          description="Each brief is checked against approved rights and brand rules before anything is produced."
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
            initial={demoPrefill ?? undefined}
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
      {deletedTitle && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2.5 rounded-xl bg-emerald-50 px-4 py-3 text-[13px] text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 break-words">“{deletedTitle}” deleted successfully.</span>
          <button
            type="button"
            onClick={dismissDeleted}
            aria-label="Dismiss deletion confirmation"
            className="shrink-0 rounded-full p-1 hover:bg-emerald-100 dark:hover:bg-emerald-900"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      )}
      {demo && !formOpen && (() => {
        const prefill = demoPrefillFor(demo.id);
        if (!prefill) return null;
        return (
          <div
            role="status"
            className="rounded-xl bg-amber-50 px-4 py-3 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:ring-amber-900"
          >
            <p className="text-[13px] font-semibold text-amber-800 dark:text-amber-200">
              Demo brief - {demo.title} (read-only demo, nothing created yet)
            </p>
            <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-amber-800 dark:text-amber-200">
              {DEMO_BOUNDARY_NOTICE} Suggested template: {prefill.suggestedTemplate} · Suggested formats: {prefill.suggestedFormats.join(", ")}.
            </p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button onClick={startFromDemoBrief} className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400">
                Open brief in campaign form
              </Button>
              <Button variant="outline" onClick={dismissDemo} className="rounded-full">
                Dismiss
              </Button>
            </div>
          </div>
        );
      })()}
      {status === "loading" && <LoadingSkeleton rows={3} />}
      {status === "ready" && (
        <>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter campaigns by stage">
            {FILTERS.map((f) => {
              const count = countFor(f.key);
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
              title={active === "all" ? "No campaigns yet" : active === "archived" ? "No archived campaigns" : "Nothing in this stage"}
              body={active === "all"
                ? "Get started in four steps: add approved material, brief a campaign, run the permission check, then produce the assets."
                : active === "archived"
                  ? "Archived campaigns leave the normal lists but stay readable - archive one from its detail page to see it here."
                  : "No campaigns currently match this stage. Clear the filter to see everything."}
              actions={active === "all" ? (
                <>
                  <Button asChild variant="outline" className="rounded-full">
                    <Link href="/consents">1 · Creator permissions</Link>
                  </Button>
                  <Button asChild variant="outline" className="rounded-full">
                    <Link href="/media">2 · Media library</Link>
                  </Button>
                  <Button onClick={() => setFormOpen(true)} className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400">
                    3 · New campaign
                  </Button>
                  <Button asChild variant="outline" className="rounded-full">
                    <Link href="/demo-campaigns">View demo campaigns</Link>
                  </Button>
                </>
              ) : undefined}
            />
          ) : (
            <div className="grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
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
