"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, Check, Copy, History, Link2, MessageSquare, Sparkles, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FadeIn } from "@/components/motion-primitives";
import { CAPABILITY_PRICE_MAP, type Campaign } from "@/server/types";
import { cn } from "@/lib/utils";

interface TimelineEntry {
  kind: string;
  at: string;
  summary: string;
  id: string;
}

interface Caption {
  platform: string;
  text: string;
  claimsUsed: string[];
  disclosure: string;
}

export function CampaignExtras({ campaign }: { campaign: Campaign }) {
  const [captions, setCaptions] = useState<Caption[]>(campaign.captions ?? []);
  const [captionMsg, setCaptionMsg] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(campaign.shareToken ? `/share/${campaign.shareToken}` : null);
  const [timeline, setTimeline] = useState<TimelineEntry[] | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [variantMsg, setVariantMsg] = useState<string | null>(null);

  const loadTimeline = useCallback(() => {
    fetch(`/api/campaigns/${campaign.id}/timeline`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load failed"))))
      .then((d) => setTimeline(d.timeline))
      .catch(() => undefined);
  }, [campaign.id]);

  useEffect(loadTimeline, [loadTimeline]);

  const allowed = campaign.preflight?.decision === "allow";
  const estimate = (campaign.preflight?.plan ?? []).reduce((sum, stage) => {
    const price = CAPABILITY_PRICE_MAP[stage.capability];
    if (!price) return sum;
    return sum + (price.unit === "second" ? price.usd * 5 : price.usd);
  }, 0);
  const spent = campaign.jobs.filter((j) => j.status === "succeeded").reduce((s, j) => s + (j.costUsd ?? 0), 0);

  async function generateCaptions() {
    setBusy("captions");
    setCaptionMsg(null);
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/captions`, { method: "POST" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      setCaptions(j.captions);
    } catch (e) {
      setCaptionMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function createShare() {
    setBusy("share");
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/share`, { method: "POST" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      setShareUrl(j.url);
      setCopied(false);
    } finally {
      setBusy(null);
    }
  }

  async function postComment() {
    if (!comment.trim()) return;
    setBusy("comment");
    try {
      await fetch(`/api/campaigns/${campaign.id}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ author: "manager", text: comment })
      });
      setComment("");
      loadTimeline();
    } finally {
      setBusy(null);
    }
  }

  async function createVariants(platforms: string[]) {
    setBusy("variants");
    setVariantMsg(null);
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/variants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platforms })
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      setVariantMsg(`Created: ${j.campaigns.map((c: { title: string }) => c.title).join(", ")} — each independently preflighted.`);
    } catch (e) {
      setVariantMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const otherPlatforms = ["instagram", "tiktok", "youtube", "linkedin"].filter((p) => p !== campaign.request.platform);

  return (
    <div className="space-y-4">
      {/* Cost + captions + share */}
      <FadeIn>
        <section className="rounded-2xl border border-border bg-card p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold tracking-tight">Captions, cost & client link</h2>
            {allowed && (
              <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                <Zap className="h-3.5 w-3.5 text-amber-500" />
                estimate ~${estimate.toFixed(2)} · spent ${spent.toFixed(4)}
              </div>
            )}
          </div>

          {allowed && (
            <>
              <Button variant="outline" size="sm" onClick={generateCaptions} disabled={busy !== null} className="mt-4 rounded-full">
                <Sparkles className={cn("h-3.5 w-3.5", busy === "captions" && "animate-pulse")} />
                {captions.length > 0 ? "Regenerate captions" : "Generate captions & claims manifest"}
              </Button>
              {captionMsg && <p className="mt-2 text-[12px] text-rose-600">{captionMsg}</p>}
              {captions.length > 0 && (
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {captions.map((c, i) => (
                    <div key={i} className="rounded-xl bg-muted/60 p-3.5 ring-1 ring-border">
                      <p className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground">
                        {c.platform} · disclosure {c.disclosure}
                      </p>
                      <p className="mt-1.5 text-[13px] leading-relaxed">{c.text}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {c.claimsUsed.map((claim) => (
                          <span key={claim} className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10.5px] text-emerald-700 ring-1 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800">
                            <BadgeCheck className="h-3 w-3" /> {claim}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-5">
            {!shareUrl ? (
              <Button variant="outline" size="sm" onClick={createShare} disabled={busy !== null || campaign.receipts.length === 0} className="rounded-full">
                <Link2 className="h-3.5 w-3.5" /> Create client share link
              </Button>
            ) : (
              <>
                <Link href={shareUrl} className="rounded-full bg-muted/60 px-3.5 py-1.5 font-mono text-[11.5px] text-emerald-700 ring-1 ring-border hover:text-emerald-800 dark:text-emerald-300">
                  {shareUrl}
                </Link>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 rounded-full px-2.5"
                  onClick={() => {
                    navigator.clipboard.writeText(window.location.origin + shareUrl);
                    setCopied(true);
                  }}
                >
                  <Copy className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
                </Button>
              </>
            )}
            {campaign.receipts.length === 0 && <p className="text-[12px] text-muted-foreground">Produce the pack first — a share link needs outputs to review.</p>}
          </div>
        </section>
      </FadeIn>

      {/* Variants */}
      <FadeIn>
        <section className="rounded-2xl border border-dashed border-border bg-card p-6">
          <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            <Zap className="h-3.5 w-3.5" /> Platform variants — clone this brief, preflight each independently
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {otherPlatforms.map((p) => (
              <Button key={p} variant="outline" size="sm" onClick={() => createVariants([p])} disabled={busy !== null} className="rounded-full capitalize">
                {busy === "variants" ? "Creating…" : `+ ${p} variant`}
              </Button>
            ))}
          </div>
          {variantMsg && <p className="mt-3 text-[12.5px] text-muted-foreground">{variantMsg}</p>}
        </section>
      </FadeIn>

      {/* Comments + timeline */}
      <FadeIn>
        <section className="rounded-2xl border border-border bg-card p-6">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <History className="h-4 w-4 text-muted-foreground" /> Comments & audit timeline
          </h2>
          <div className="mt-4 flex gap-2">
            <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add an internal note…" className="h-9 rounded-lg" />
            <Button size="sm" variant="outline" onClick={postComment} disabled={!comment.trim() || busy !== null} className="h-9 rounded-lg">
              <MessageSquare className="h-3.5 w-3.5" /> Note
            </Button>
          </div>
          <div className="mt-4 space-y-0">
            {(timeline ?? []).slice(0, 12).map((entry, idx, arr) => (
              <div key={entry.id} className="relative flex gap-3 pb-4 last:pb-0">
                {!arr.slice(idx + 1).length || <span className="absolute left-[5px] top-4 h-full w-px bg-border" />}
                <span className={cn("relative z-10 mt-1 h-2.5 w-2.5 shrink-0 rounded-full", entry.kind === "comment" ? "bg-violet-500" : entry.kind.includes("block") || entry.kind.includes("revoked") ? "bg-rose-500" : "bg-emerald-500")} />
                <div className="min-w-0">
                  <p className="text-[12.5px] leading-snug">{entry.summary}</p>
                  <p className="mt-0.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">
                    {entry.kind} · {new Date(entry.at).toLocaleString()}
                  </p>
                </div>
              </div>
            ))}
            {timeline && timeline.length === 0 && <p className="text-[12.5px] text-muted-foreground">No events yet.</p>}
          </div>
        </section>
      </FadeIn>
    </div>
  );
}
