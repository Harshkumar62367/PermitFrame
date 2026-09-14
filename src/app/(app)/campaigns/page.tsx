"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FadeIn, Stagger, StaggerItem } from "@/components/motion-primitives";
import { NewCampaignForm } from "@/components/new-campaign-form";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { useBootstrap } from "@/lib/bootstrap";

export default function CampaignsPage() {
  const boot = useBootstrap();
  const router = useRouter();
  const [formOpen, setFormOpen] = useState(false);

  if (boot.status === "loading") {
    return (
      <div className="pf-page space-y-6">
        <LoadingSkeleton rows={3} />
      </div>
    );
  }

  if (boot.status === "failed") {
    return (
      <div className="pf-page space-y-6">
        <ErrorState message={boot.error} onRetry={boot.refresh} />
      </div>
    );
  }

  const campaigns = boot.snapshot.campaigns;

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
              boot.refresh();
              router.push(`/campaigns/${id}`);
            }}
          />
        </FadeIn>
      )}

      <Stagger className="grid gap-4 md:grid-cols-2">
        {(campaigns ?? []).map((c) => (
          <StaggerItem key={c.id}>
            <Link
              href={`/campaigns/${c.id}`}
              className="group block h-full rounded-2xl border border-border bg-card p-5 transition-all duration-300 hover:-translate-y-0.5 hover:border-emerald-600/30 hover:shadow-[0_12px_40px_-16px_rgba(16,185,129,0.2)]"
            >
              <div className="flex items-center justify-between gap-2">
                <StatusBadge status={c.status} />
                <span className="truncate font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
                  {c.platform} · {c.country}
                </span>
              </div>
              <h3 className="mt-3.5 text-[15px] font-semibold leading-snug tracking-tight">{c.title}</h3>
              {c.demoNote && <p className="mt-2 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground">{c.demoNote}</p>}
              <p className="mt-4 inline-flex items-center gap-1 text-[12px] font-medium text-emerald-700 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100 dark:text-emerald-300">
                Open workspace <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </p>
            </Link>
          </StaggerItem>
        ))}
      </Stagger>
      {!campaigns && <LoadingSkeleton rows={2} />}
      {campaigns.length === 0 && (
        <EmptyState title="No campaigns yet" body="Create the first request — preflight checks rights and claims before anything generates." />
      )}
    </div>
  );
}
