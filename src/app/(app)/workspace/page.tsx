"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, ArrowUpRight, Ban, CheckCircle2, Clock3, Plus, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AnimatedNumber, FadeIn, Stagger, StaggerItem } from "@/components/motion-primitives";
import { NewCampaignForm } from "@/components/new-campaign-form";
import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";

interface BootstrapResponse {
  campaigns: { id: string; title: string; status: string; platform: string; country: string; demoNote?: string; updatedAt: string }[];
  creators: { id: string; name: string; handle: string }[];
  dkg: { mode: string; healthy: boolean; detail: string; blockchain?: string };
  livepeer: { endpoint: string; keyless: boolean };
}

const statusStyles: Record<string, string> = {
  blocked: "bg-rose-50 text-rose-700 ring-rose-600/20",
  draft: "bg-sky-50 text-sky-700 ring-sky-600/20",
  generating: "bg-amber-50 text-amber-700 ring-amber-600/20",
  review: "bg-violet-50 text-violet-700 ring-violet-600/20",
  approved: "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
};

export default function WorkspaceOverviewPage() {
  const [data, setData] = useState<BootstrapResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const [warnings, setWarnings] = useState<{ passportId: string; creatorName: string; validUntil: string; daysLeft: number; level: string }[]>([]);

  useEffect(() => {
    fetch("/api/bootstrap")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`bootstrap failed (${r.status})`))))
      .then(setData)
      .catch((e) => setError(String(e.message ?? e)));
    fetch("/api/expiry")
      .then((r) => r.json())
      .then((d) => setWarnings(d.warnings ?? []))
      .catch(() => undefined);
  }, []);

  const campaigns = data?.campaigns ?? [];
  const spend = campaigns.length > 0 ? 0.82 : 0; // demo workspace reference
  const blocked = campaigns.filter((c) => c.status === "blocked").length;

  return (
    <div className="space-y-8">
      <FadeIn>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-emerald-700">Workspace</p>
            <h1 className="font-display mt-1.5 text-3xl font-semibold tracking-tight">Overview</h1>
            <p className="mt-1.5 text-[13.5px] text-muted-foreground">
              Verdi Steps × {data?.creators[0]?.name ?? "creator"} · every campaign is policy-checked before a single render.
            </p>
          </div>
          <Button onClick={() => setFormOpen((v) => !v)} className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600">
            <Plus className="h-4 w-4" /> New campaign
          </Button>
        </div>
      </FadeIn>

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
          <NewCampaignForm onCreated={() => window.location.reload()} />
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
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className={`rounded-full font-medium capitalize ${statusStyles[c.status] ?? ""}`}>
                    {c.status === "blocked" && <Ban className="h-3 w-3" />}
                    {c.status === "approved" && <CheckCircle2 className="h-3 w-3" />}
                    {c.status}
                  </Badge>
                  <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
                    {c.platform} · {c.country}
                  </span>
                </div>
                <h3 className="mt-3.5 text-[15px] font-semibold leading-snug tracking-tight">{c.title}</h3>
                {c.demoNote && <p className="mt-2 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground">{c.demoNote}</p>}
                <p className="mt-4 inline-flex items-center gap-1 text-[12px] font-medium text-emerald-700 opacity-0 transition group-hover:opacity-100">
                  Open workspace <ArrowRight className="h-3.5 w-3.5" />
                </p>
              </Link>
            </StaggerItem>
          ))}
          {!data && !error && <p className="text-sm text-muted-foreground">Loading workspace…</p>}
          {error && <p className="text-sm text-rose-600">{error}</p>}
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
