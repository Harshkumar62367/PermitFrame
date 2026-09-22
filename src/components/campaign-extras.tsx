"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, ChevronDown, Copy, History, Link2, MessageSquare, Sparkles, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FadeIn } from "@/components/motion-primitives";
import { apiGet, apiPost } from "@/lib/api";
import { useLongAction } from "@/lib/use-long-action";
import { useInvalidateWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import { CAPABILITY_PRICE_MAP, hasSharableReceipt, type Campaign } from "@/server/types";
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

/** Plain-language event kinds for the audit timeline - never raw internals. */
function plainEventKind(kind: string): string {
  if (kind === "comment") return "note";
  if (kind.startsWith("preflight.")) return "permission check";
  if (kind.startsWith("dkg.")) return "proof record";
  if (kind.startsWith("production.")) return "production";
  if (kind === "campaign.approved") return "approval";
  if (kind.startsWith("passport.")) return "creator permission";
  if (kind === "facts.updated") return "brand rules";
  if (kind === "media.registered") return "media";
  if (kind.startsWith("share.")) return "client review";
  return kind;
}

export function CampaignExtras({ campaign, hideVariants = false }: { campaign: Campaign; hideVariants?: boolean }) {
  const [captions, setCaptions] = useState<Caption[]>(campaign.captions ?? []);
  const [captionMsg, setCaptionMsg] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(campaign.shareToken ? `/share/${campaign.shareToken}` : null);
  const [shareError, setShareError] = useState<string | null>(null);
  // A share link is a database-only write - no proof wording, ever. It is
  // normally quick, but a cold database connection can be slow; communicate
  // that before the browser's timeout instead of making a successful write
  // look like a failed action. Stays at 90s, not the 120s ledger policy.
  const shareAction = useLongAction(
    {
      working: "Creating a private review link. This normally takes a few seconds - please wait before retrying.",
      slow: "Still creating your private review link. Please keep this page open - it can take up to about a minute on a cold database connection.",
      timedOut:
        "Creating the client link is taking longer than expected. Refresh this page once before retrying - the link may already have been created."
    },
    { timeoutMs: 90_000 }
  );
  const [timeline, setTimeline] = useState<TimelineEntry[] | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [commentError, setCommentError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [variants, setVariants] = useState<{ id: string; title: string }[] | null>(null);
  const [variantMsg, setVariantMsg] = useState<string | null>(null);
  // Which platform button is mid-creation. Buttons share the `busy` lock so
  // two variants can never be created concurrently, but only the clicked one
  // reads "Creating…" - the others keep their labels.
  const [pendingVariant, setPendingVariant] = useState<string | null>(null);
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();

  const loadTimeline = useCallback(() => {
    apiGet<{ timeline: TimelineEntry[] }>(`/api/campaigns/${campaign.id}/timeline`)
      .then((d) => {
        setTimeline(d.timeline);
        setTimelineError(null);
      })
      .catch((e) => setTimelineError(e instanceof Error ? e.message : "Timeline failed to load."));
  }, [campaign.id]);

  // The timeline is collapsed by default and fetched only on first expand -
  // long audit lists stay out of the way (and off the network) until needed.
  // Posting a note refreshes the data directly, whether open or not.
  useEffect(() => {
    if (timelineOpen && timeline === null && !timelineError) loadTimeline();
  }, [timelineOpen, timeline, timelineError, loadTimeline]);

  const allowed = campaign.preflight?.decision === "allow";
  const estimate = (campaign.preflight?.plan ?? []).reduce((sum, stage) => {
    const price = CAPABILITY_PRICE_MAP[stage.capability];
    if (!price) return sum;
    return sum + (price.unit === "second" ? price.usd * 5 : price.usd);
  }, 0);
  const spent = campaign.jobs.filter((j) => j.status === "ready_to_share").reduce((s, j) => s + (j.costUsd ?? 0), 0);

  async function generateCaptions() {
    if (busy) return;
    setBusy("captions");
    setCaptionMsg(null);
    try {
      const j = await apiPost<{ captions: Caption[] }>(`/api/campaigns/${campaign.id}/captions`);
      setCaptions(j.captions);
      invalidateSnapshot();
    } catch (e) {
      setCaptionMsg(e instanceof Error ? e.message : "Caption generation failed.");
    } finally {
      setBusy(null);
    }
  }

  async function createShare() {
    if (busy || shareAction.busy) return;
    setBusy("share");
    setShareError(null);
    const result = await shareAction.execute(() =>
      apiPost<{ token: string; url: string }>(
        `/api/campaigns/${campaign.id}/share`,
        undefined,
        undefined,
        shareAction.timeoutMs
      )
    );
    setBusy(null);
    if (!result.ok || !result.value) {
      // Refresh-first: the link may already exist server-side.
      setShareError(result.message ?? "Share link creation failed.");
      return;
    }
    const j = result.value;
    setShareUrl(j.url);
    setCopied(false);
    setCopyFailed(false);
  }

  async function copyShare() {
    if (!shareUrl) return;
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(window.location.origin + shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  }

  async function postComment() {
    if (!comment.trim() || busy) return;
    setBusy("comment");
    setCommentError(null);
    try {
      await apiPost(`/api/campaigns/${campaign.id}/comments`, { author: "manager", text: comment });
      setComment("");
      invalidateSnapshot();
      loadTimeline();
    } catch (e) {
      // Draft is preserved for retry.
      setCommentError(e instanceof Error ? e.message : "Note failed to post. Your draft is preserved.");
    } finally {
      setBusy(null);
    }
  }

  async function createVariants(platforms: string[]) {
    if (busy) return;
    setBusy("variants");
    setPendingVariant(platforms[0] ?? null);
    setVariantMsg(null);
    setVariants(null);
    try {
      // Variant creation runs a full permission check (DKG reads), which can
      // take well over the default 30s budget - allow two minutes and say
      // so honestly on timeout instead of blaming the network.
      const j = await apiPost<{ campaigns: { id: string; title: string }[] }>(
        `/api/campaigns/${campaign.id}/variants`,
        { platforms },
        undefined,
        120000
      );
      setVariants(j.campaigns);
      if (j.campaigns.length > 0) invalidateSnapshot();
      setVariantMsg(
        j.campaigns.length > 0
          ? `${j.campaigns.length} variant(s) created - each independently permission-checked.`
          : "No variants created - that platform matches this campaign."
      );
    } catch (e) {
      setVariantMsg(e instanceof Error ? e.message : "Variant creation failed.");
    } finally {
      setBusy(null);
      setPendingVariant(null);
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
              {captionMsg && <p role="alert" className="mt-2 break-words text-[12px] text-rose-600 dark:text-rose-300">{captionMsg}</p>}
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
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={createShare}
                  disabled={busy !== null || !campaign.receipts.some((r) => hasSharableReceipt(r))}
                  aria-busy={busy === "share"}
                  title={campaign.receipts.length === 0 ? "Produce the pack first - a share link needs outputs to review" : "Share links unlock once an output is ready-to-share - previews stay private"}
                  className="rounded-full"
                >
                  <Link2 className="h-3.5 w-3.5" aria-hidden /> {busy === "share" ? "Creating…" : "Create client share link"}
                </Button>
                {busy === "share" && shareAction.status && (
                  <p role="status" className="basis-full text-[12px] text-muted-foreground">
                    {shareAction.status}
                  </p>
                )}
                {shareError && <p role="alert" className="break-words text-[12px] text-rose-600 dark:text-rose-300">{shareError}</p>}
              </div>
            ) : (
              <>
                <Link href={shareUrl} className="rounded-full bg-muted/60 px-3.5 py-1.5 font-mono text-[11.5px] text-emerald-700 ring-1 ring-border hover:text-emerald-800 dark:text-emerald-300">
                  {shareUrl}
                </Link>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 rounded-full px-2.5"
                  onClick={copyShare}
                  aria-label={copyFailed ? "Copy failed - select the link manually" : "Copy client share link"}
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden /> {copied ? "Copied" : "Copy"}
                </Button>
                {copyFailed && (
                  <p role="alert" className="text-[12px] text-amber-600 dark:text-amber-300">
                    Clipboard blocked - long-press the link to copy it manually.
                  </p>
                )}
              </>
            )}
            {campaign.receipts.length === 0 && <p className="text-[12px] text-muted-foreground">Produce the pack first - a share link needs outputs to review.</p>}
            {campaign.receipts.length > 0 && !campaign.receipts.some((r) => hasSharableReceipt(r)) && (
              <p className="text-[12px] text-muted-foreground">Outputs are still preview-only - the share link unlocks once durable storage confirms one.</p>
            )}
          </div>
        </section>
      </FadeIn>

      {/* Variants - hidden when the Creative Studio owns the asset-pack workflow. */}
      {!hideVariants && (
      <FadeIn>
        <section className="rounded-2xl border border-dashed border-border bg-card p-6">
          <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            <Zap className="h-3.5 w-3.5" /> Platform variants - clone this brief, permission-check each independently
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {otherPlatforms.map((p) => (
              <Button
                key={p}
                variant="outline"
                size="sm"
                onClick={() => createVariants([p])}
                disabled={busy !== null}
                aria-busy={pendingVariant === p}
                title={pendingVariant === p ? `Creating the ${p} variant - permission check runs first` : `Clone this brief for ${p}`}
                className="rounded-full capitalize"
              >
                {pendingVariant === p ? "Creating…" : `+ ${p} variant`}
              </Button>
            ))}
          </div>
          {variantMsg && <p role="status" className="mt-3 break-words text-[12.5px] text-muted-foreground">{variantMsg}</p>}
          {variants && variants.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {variants.map((v) => (
                <li key={v.id}>
                  <Link href={`/campaigns/${v.id}`} className="text-[12.5px] font-medium text-emerald-700 hover:underline dark:text-emerald-300">
                    {v.title} →
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </FadeIn>
      )}

      {/* Comments + timeline - collapsed until needed */}
      <FadeIn>
        <section className="rounded-2xl border border-border bg-card p-6">
          <button
            type="button"
            onClick={() => setTimelineOpen((v) => !v)}
            aria-expanded={timelineOpen}
            aria-controls={`timeline-${campaign.id}`}
            className="flex w-full items-center gap-2 text-left text-[15px] font-semibold tracking-tight"
          >
            <History className="h-4 w-4 text-muted-foreground" /> Comments & audit timeline
            {timeline !== null && (
              <span className="font-mono text-[11px] font-normal text-muted-foreground">{timeline.length}</span>
            )}
            <ChevronDown className={cn("ml-auto h-4 w-4 text-muted-foreground transition-transform", timelineOpen && "rotate-180")} aria-hidden />
          </button>
          {timelineOpen && (
          <div id={`timeline-${campaign.id}`}>
          <div className="mt-4 flex gap-2">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor={`note-${campaign.id}`} className="sr-only">Add an internal note</Label>
              <Input
                id={`note-${campaign.id}`}
                value={comment}
                onChange={(e) => {
                  setComment(e.target.value);
                  setCommentError(null);
                }}
                placeholder="Add an internal note…"
                aria-invalid={Boolean(commentError)}
                className="h-9 rounded-lg"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={postComment}
              disabled={!comment.trim() || busy !== null}
              aria-busy={busy === "comment"}
              title={!comment.trim() ? "Write a note to enable posting" : undefined}
              className="h-9 shrink-0 rounded-lg"
            >
              <MessageSquare className="h-3.5 w-3.5" aria-hidden /> {busy === "comment" ? "Posting…" : "Note"}
            </Button>
          </div>
          {commentError && <p role="alert" className="mt-2 break-words text-[12px] text-rose-600 dark:text-rose-300">{commentError}</p>}
          <div className="mt-4 space-y-0">
            {!timeline && !timelineError && <p className="text-[12.5px] text-muted-foreground">Loading timeline…</p>}
            {timelineError && (
              <p role="alert" className="break-words text-[12.5px] text-rose-600 dark:text-rose-300">
                Timeline unavailable: {timelineError}{" "}
                <button type="button" onClick={loadTimeline} className="font-medium underline underline-offset-2">Retry</button>
              </p>
            )}
            {(timeline ?? []).slice(0, 12).map((entry, idx, arr) => (
              <div key={entry.id} className="relative flex gap-3 pb-4 last:pb-0">
                {!arr.slice(idx + 1).length || <span className="absolute left-[5px] top-4 h-full w-px bg-border" />}
                <span className={cn("relative z-10 mt-1 h-2.5 w-2.5 shrink-0 rounded-full", entry.kind === "comment" ? "bg-violet-500" : entry.kind.includes("block") || entry.kind.includes("revoked") ? "bg-rose-500" : "bg-emerald-500")} />
                <div className="min-w-0">
                  <p className="text-[12.5px] leading-snug">{entry.summary}</p>
                    <p className="mt-0.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">
                      {plainEventKind(entry.kind)} · {new Date(entry.at).toLocaleString()}
                    </p>
                </div>
              </div>
            ))}
            {timeline && timeline.length === 0 && <p className="text-[12.5px] text-muted-foreground">No events yet.</p>}
          </div>
          </div>
          )}
        </section>
      </FadeIn>
    </div>
  );
}
