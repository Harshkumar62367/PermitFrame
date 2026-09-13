"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Ban, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FadeIn, Stagger, StaggerItem } from "@/components/motion-primitives";
import { NewCampaignForm } from "@/components/new-campaign-form";

interface CampaignRow {
  id: string;
  title: string;
  status: string;
  platform: string;
  country: string;
  demoNote?: string;
  updatedAt: string;
}

const statusStyles: Record<string, string> = {
  blocked: "bg-rose-50 text-rose-700 ring-rose-600/20",
  draft: "bg-sky-50 text-sky-700 ring-sky-600/20",
  generating: "bg-amber-50 text-amber-700 ring-amber-600/20",
  review: "bg-violet-50 text-violet-700 ring-violet-600/20",
  approved: "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
};

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<CampaignRow[] | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => {
    fetch("/api/campaigns")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load failed"))))
      .then((d) => setCampaigns(d.campaigns))
      .catch(() => setCampaigns([]));
  }, []);

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-emerald-700">Workspace</p>
            <h1 className="font-display mt-1.5 text-3xl font-semibold tracking-tight">Campaigns</h1>
            <p className="mt-1.5 text-[13.5px] text-muted-foreground">
              Each request is compiled against rights and facts before generation is allowed.
            </p>
          </div>
          <Button onClick={() => setFormOpen((v) => !v)} className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600">
            New campaign
          </Button>
        </div>
      </FadeIn>

      {formOpen && (
        <FadeIn>
          <NewCampaignForm />
        </FadeIn>
      )}

      <Stagger className="grid gap-4 md:grid-cols-2">
        {(campaigns ?? []).map((c) => (
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
      </Stagger>
      {campaigns && campaigns.length === 0 && (
        <p className="text-sm text-muted-foreground">No campaigns yet — create the first one.</p>
      )}
    </div>
  );
}
