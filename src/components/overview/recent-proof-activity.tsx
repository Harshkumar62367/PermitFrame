"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  FileText,
  Fingerprint,
  ImagePlus,
  Play,
  RefreshCw,
  Share2,
  ShieldCheck,
  Stamp,
  type LucideIcon
} from "lucide-react";
import { FadeIn } from "@/components/motion-primitives";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import type { SnapshotActivityItem } from "@/lib/use-workspace-snapshot";

interface ActivityPresentation {
  icon: LucideIcon;
  label: string;
  href: (item: SnapshotActivityItem) => string | null;
}

function presentationFor(kind: string): ActivityPresentation {
  if (kind === "preflight.block")
    return { icon: Ban, label: "Changes needed before creation", href: (i) => (i.campaignId ? `/campaigns/${i.campaignId}` : null) };
  if (kind === "preflight.allow")
    return { icon: ShieldCheck, label: "Approved to create", href: (i) => (i.campaignId ? `/campaigns/${i.campaignId}` : null) };
  if (kind === "production.start" || kind === "production.run")
    return { icon: Play, label: kind === "production.start" ? "Production started" : "Production output completed", href: (i) => (i.campaignId ? `/campaigns/${i.campaignId}` : null) };
  if (kind === "dkg.publish")
    return { icon: Fingerprint, label: "Derivative receipt published", href: (i) => (i.campaignId ? `/campaigns/${i.campaignId}` : null) };
  if (kind === "campaign.approved")
    return { icon: Stamp, label: "Campaign approved", href: (i) => (i.campaignId ? `/campaigns/${i.campaignId}` : null) };
  if (kind === "passport.revoked" || kind === "passport.renewed")
    return { icon: RefreshCw, label: kind === "passport.revoked" ? "Permission revoked" : "Permission renewed", href: () => "/consents" };
  if (kind === "facts.updated")
    return { icon: FileText, label: "Product fact verified", href: () => "/products" };
  if (kind === "media.registered")
    return { icon: ImagePlus, label: "Source media registered", href: () => "/media" };
  if (kind.startsWith("share."))
    return { icon: Share2, label: "Client review", href: (i) => (i.campaignId ? `/campaigns/${i.campaignId}` : null) };
  return { icon: CheckCircle2, label: "Workspace event", href: (i) => (i.campaignId ? `/campaigns/${i.campaignId}` : null) };
}

function formatTime(at: string): { title: string; short: string } {
  const date = new Date(at);
  const title = Number.isNaN(date.getTime()) ? at : date.toLocaleString();
  const short = Number.isNaN(date.getTime())
    ? at
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " " +
      date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return { title, short };
}

/**
 * Compact proof feed: real application events with evidence links.
 * Honest empty state when nothing has happened yet - never synthetic rows.
 */
export function RecentProofActivity({ activity }: { activity: SnapshotActivityItem[] }) {
  const [open, setOpen] = useState(true);
  return (
    <FadeIn subtle>
      <section aria-label="Recent proof and activity" className="rounded-2xl border border-border bg-card p-5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="recent-proof-list"
          className="flex w-full flex-wrap items-baseline justify-between gap-2 text-left"
        >
          <span className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            Recent proof
            {activity.length > 0 && (
              <span className="font-mono text-[11px] font-normal text-muted-foreground">{activity.length}</span>
            )}
            <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
          </span>
          <span className="text-[12px] font-normal text-muted-foreground">Every row links to its record</span>
        </button>
        {open && (
        <div id="recent-proof-list">
        {activity.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              title="No workspace activity yet"
              body="Brief a campaign - its permission-check decision is recorded here with the evidence behind it."
            />
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {activity.map((item) => {
              const presentation = presentationFor(item.kind);
              const href = presentation.href(item);
              const time = formatTime(item.at);
              const Icon = presentation.icon;
              const row = (
                <>
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground" aria-hidden>
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] leading-snug">
                      <span className="font-medium">{presentation.label}</span>
                      {item.campaignTitle && <span className="text-muted-foreground"> · {item.campaignTitle}</span>}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[12px] leading-relaxed text-muted-foreground">{item.summary}</span>
                  </span>
                  <time dateTime={item.at} title={time.title} className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                    {time.short}
                  </time>
                </>
              );
              return (
                <li key={item.id}>
                  {href ? (
                    <Link
                      href={href}
                      className="flex items-center gap-3 rounded-xl px-2 py-2.5 transition hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
                    >
                      {row}
                    </Link>
                  ) : (
                    <div className="flex items-center gap-3 px-2 py-2.5">{row}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        </div>
        )}
      </section>
    </FadeIn>
  );
}
