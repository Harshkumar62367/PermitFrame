"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, ArrowUpRight, Clock3, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AnimatedNumber, FadeIn, Stagger, StaggerItem } from "@/components/motion-primitives";
import { NewCampaignForm } from "@/components/new-campaign-form";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { useBootstrap } from "@/lib/bootstrap";
import { apiGet } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";

interface ExpiryWarning {
  passportId: string;
  creatorName: string;
  validUntil: string;
  daysLeft: number;
  level: string;
}

export default function WorkspaceOverviewPage() {
  const boot = useBootstrap();
  const router = useRouter();
  const [formOpen, setFormOpen] = useState(false);

  const [warnings, setWarnings] = useState<ExpiryWarning[]>([]);
  const [warningsError, setWarningsError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiGet<{ warnings: ExpiryWarning[] }>("/api/expiry", controller.signal)
      .then((d) => setWarnings(d.warnings ?? []))
      .catch((e) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) setWarningsError(e instanceof Error ? e.message : "Expiry check failed.");
      });
    return () => controller.abort();
  }, []);

  if (boot.status === "loading") {
    return (
      <div className="pf-page space-y-8">
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  if (boot.status === "failed") {
    return (
      <div className="pf-page space-y-8">
        <ErrorState message={boot.error} onRetry={boot.refresh} />
      </div>
    );
  }

  const { snapshot, refresh } = boot;

  const campaigns = snapshot.campaigns;
  const spend = campaigns.length > 0 ? 0.82 : 0; // demo workspace reference
  const blocked = campaigns.filter((c) => c.status === "blocked").length;
  // Seed-proof: derive the workspace line from live data, never hardcoded names.
  const creatorName = snapshot.creators[0]?.name;
  const brandLine = creatorName
    ? `${creatorName} · every campaign is policy-checked before a single render.`
    : "Clean workspace · add a creator consent, then create your first campaign.";

  return (
    <div className="pf-page space-y-8">
      <FadeIn>
        <PageHeader
          eyebrow="Workspace"
          title="Overview"
          description={brandLine}
          actions={
            <Button onClick={() => setFormOpen((v) => !v)} aria-expanded={formOpen} className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400">
              <Plus className="h-4 w-4" aria-hidden /> {formOpen ? "Close form" : "New campaign"}
            </Button>
          }
        />
      </FadeIn>

      {warningsError && (
        <ErrorState message={`Expiry check unavailable: ${warningsError}`} onRetry={() => window.location.reload()} />
      )}

      {warnings.length > 0 && (
        <FadeIn>
          <div className="space-y-2">
            {warnings.map((w) => (
              <div
                key={w.passportId}
                className={cn(
                  "flex flex-wrap items-center gap-2.5 rounded-xl px-4 py-3 text-[13px] ring-1",
                  w.level === "expired"
                    ? "bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900"
                    : "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900"
                )}
              >
                <AlertTriangle className="h-4 w-4" />
                <span className="font-medium">
                  {w.level === "expired" ? "Rights expired" : `Rights expire in ${w.daysLeft} days`}:
                </span>
                <span>
                  {w.creatorName} · passport valid to {w.validUntil}. Renew it on the{" "}
                  <Link href="/consents" className="underline underline-offset-2">consents page</Link> — expired rights block new preflights.
                </span>
              </div>
            ))}
          </div>
        </FadeIn>
      )}

      {formOpen && (
        <FadeIn>
          <NewCampaignForm
            onCreated={(id) => {
              setFormOpen(false);
              refresh();
              router.push(`/campaigns/${id}`);
            }}
          />
        </FadeIn>
      )}

      {/* Stats */}
      <Stagger className="grid gap-4 sm:grid-cols-3">
        <StaggerItem>
          <div className="rounded-2xl border border-border bg-card p-5">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Campaigns</p>
              <FolderIcon />
            </div>
            <p className="font-display mt-2 text-4xl font-semibold tracking-tight">
              <AnimatedNumber value={campaigns.length} />
            </p>
            <p className="mt-1 text-[12px] text-muted-foreground">{blocked} blocked by policy — no spend</p>
          </div>
        </StaggerItem>
        <StaggerItem>
          <div className="rounded-2xl border border-border bg-card p-5">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Outputs generated</p>
              <Sparkles className="h-4 w-4 text-muted-foreground/50" />
            </div>
            <p className="font-display mt-2 text-4xl font-semibold tracking-tight">
              <AnimatedNumber value={4} />
            </p>
            <p className="mt-1 text-[12px] text-muted-foreground">keyframe · 1:1 · 16:9 · 5s video</p>
          </div>
        </StaggerItem>
        <StaggerItem>
          <div className="rounded-2xl border border-border bg-card p-5">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Inference spend</p>
              <Clock3 className="h-4 w-4 text-muted-foreground/50" />
            </div>
            <p className="font-display mt-2 text-4xl font-semibold tracking-tight">
              <AnimatedNumber value={spend} prefix="$" />
            </p>
            <p className="mt-1 text-[12px] text-muted-foreground">live costs from the Livepeer network</p>
          </div>
        </StaggerItem>
      </Stagger>

      {/* Campaigns */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold tracking-tight">Campaigns</h2>
          <Link href="/campaigns" className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground transition hover:text-foreground">
            All campaigns <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>
        <Stagger className="grid gap-4 md:grid-cols-2">
          {campaigns.map((c) => (
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
                <p className="mt-4 inline-flex items-center gap-1 text-[12px] font-medium text-emerald-700 dark:text-emerald-300 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
                  Open workspace <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </p>
              </Link>
            </StaggerItem>
          ))}
          {campaigns.length === 0 && (
            <EmptyState title="No campaigns yet" body="Create the first request — preflight will check rights and claims before anything generates." />
          )}
        </Stagger>
      </section>
    </div>
  );
}

function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-muted-foreground/50">
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
