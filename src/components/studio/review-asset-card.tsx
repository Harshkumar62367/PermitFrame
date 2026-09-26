"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Download, Maximize2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { describeActualSize } from "@/server/livepeer/aspect";
import { deriveQualityReview, qualityReviewCopy } from "@/server/livepeer/quality-review";
import { deliveryBlockReason } from "@/server/types";
import { fidelityPillFor, REFERENCE_GUIDED_COPY } from "@/lib/preservation";
import { downloadHrefFor } from "@/lib/proof-links";
import type { DerivativeReceipt, ProductionJob } from "@/server/types";

interface ReviewAssetCardProps {
  receipt: DerivativeReceipt;
  /** Owning production job (null for legacy rows); supplies advisory critique fields. */
  job: ProductionJob | null;
  /** Position in the receipts grid; reported back so the parent owns lightbox selection. */
  index: number;
  /** Pre-computed by the parent: completed stored image whose job is ready_to_share. */
  canVary: boolean;
  /** Any production activity: disables paid actions while rendering. */
  active: boolean;
  regenFor: string | null;
  varyFor: string | null;
  verificationRef: string | null;
  onRegenerate: (receiptId: string) => void;
  onRequestVary: (receiptId: string) => void;
  onOpen: (index: number) => void;
}

/**
 * One rendered output card: preview, evidence labels, preservation
 * indicator, paid-action buttons, verify/download links. View-only: no API
 * calls, no selection state - eligibility (canVary), busy flags, and all
 * callbacks come from the parent, which remains the single source of
 * truth for action state.
 */
export function ReviewAssetCard({
  receipt: r,
  job,
  index,
  canVary,
  active,
  regenFor,
  varyFor,
  verificationRef,
  onRegenerate,
  onRequestVary,
  onOpen
}: ReviewAssetCardProps) {
  // Reviewer state: hard delivery block dominates; advisory critique only
  // informs (never approves/rejects); missing data means not assessed.
  const review = deriveQualityReview(job, r);
  // Fidelity pill: earned labels only (see fidelityPillFor) - a preserved
  // claim requires a passed identity check, reference-guided never claims
  // preservation, and unknown rows render no pill at all.
  const pill = fidelityPillFor(r);
  const [playbackSeconds, setPlaybackSeconds] = useState<number | null>(null);
  return (
    <div className="group overflow-hidden rounded-xl bg-muted/60 ring-1 ring-border transition hover:ring-emerald-600/40">
      {r.mediaType === "image" ? (
        <button
          type="button"
          onClick={() => onOpen(index)}
          title={`${r.label} - click to view full size`}
          aria-label={`View ${r.label} full size`}
          className="block w-full cursor-zoom-in focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={r.outputUrl} alt={r.label} loading="lazy" className="aspect-[3/4] w-full object-cover" />
        </button>
      ) : (
        <div className="relative">
          <video
            src={r.outputUrl}
            controls
            preload="metadata"
            onLoadedMetadata={(event) => {
              const seconds = event.currentTarget.duration;
              if (Number.isFinite(seconds) && seconds > 0) setPlaybackSeconds(seconds);
            }}
            className="aspect-[3/4] w-full bg-black object-cover"
          />
          <button
            type="button"
            onClick={() => onOpen(index)}
            title={`${r.label} - click to view full size`}
            aria-label={`View ${r.label} full size`}
            className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-black/60 text-white opacity-0 transition hover:bg-black/80 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      )}
      <div className="space-y-1 p-3">
        <p className="text-[12.5px] font-medium leading-tight">
          {r.derivedFromFilmRunId && r.mediaType === "video" ? r.label.replace(/ · \d+s$/, "") : r.label}
        </p>
        {r.derivedFromFilmRunId && r.mediaType === "video" && r.requestedDurationSeconds && (
          <p className="text-[10.5px] text-muted-foreground">
            {r.durationSeconds || playbackSeconds ? `${Math.round(r.durationSeconds ?? playbackSeconds ?? 0)}s delivered` : "Checking duration"} · {r.requestedDurationSeconds}s requested
          </p>
        )}
        <p
          className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground"
          title={
            r.actualCapability && r.actualCapability !== r.capability
              ? `Planned ${r.requestedCapability ?? r.capability}, actually rendered with ${r.actualCapability}`
              : `Rendered with ${r.capability}`
          }
        >
          {r.format}
          {r.actualWidth !== undefined && r.actualHeight !== undefined && ` · ${r.actualWidth}×${r.actualHeight}`}
          {" · "}{r.actualCapability ?? r.capability}
        </p>
        {pill && (
          <p
            className={
              pill.tone === "emerald"
                ? "text-[10.5px] font-medium text-emerald-700 dark:text-emerald-300"
                : pill.tone === "rose"
                  ? "text-[10.5px] font-medium text-rose-700 dark:text-rose-300"
                  : "text-[10.5px] text-muted-foreground"
            }
            title={pill.label === "Reference-guided" ? REFERENCE_GUIDED_COPY : undefined}
          >
            {pill.label}
          </p>
        )}
        {r.visibility === "private" && r.derivedFromFilmRunId && (
          <p className="break-words text-[10.5px] font-medium leading-snug text-muted-foreground">
            Private derivative - not included in client delivery.
          </p>
        )}
        {r.supersededAt ? (
          <p role="status" className="break-words text-[11px] font-medium leading-snug text-muted-foreground">
            Replaced by a fresh generation. This rejected output is retained as private audit history and is not deliverable.
          </p>
        ) : r.aspectVerdict === "mismatch" && r.actualWidth !== undefined && r.actualHeight !== undefined ? (
          <p role="status" className="break-words text-[11px] font-medium leading-snug text-amber-700 dark:text-amber-300">
            Needs ratio review - requested {r.format}, received {describeActualSize(r.actualWidth, r.actualHeight)}. Stored and editable, but not deliverable to clients until regenerated.
          </p>
        ) : (
          <p className="text-[10.5px] text-muted-foreground" title={r.storageStatus === "stored" ? "Persisted to PermitFrame durable storage; the provider original stays on record" : r.visibility === "private" ? "Private finishing result hosted by the provider" : "Provider-hosted legacy output - previewable, but not share-ready until stored securely"}>
            {r.storageStatus === "stored" ? "Stored in PermitFrame" : r.visibility === "private" ? "Provider-hosted private derivative" : r.storageStatus === "failed" ? "Storage failed" : "Provider-hosted legacy asset"}
          </p>
        )}
        <div
          className={
            review.state === "delivery_blocked" || review.state === "needs_attention"
              ? "rounded-lg bg-amber-50/70 px-2 py-1.5 ring-1 ring-amber-600/20 dark:bg-amber-950/30 dark:ring-amber-800/50"
              : "rounded-lg bg-muted/60 px-2 py-1.5 ring-1 ring-border"
          }
        >
          <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">Quality review</p>
          <p
            role="status"
            className={
              review.state === "delivery_blocked" || review.state === "needs_attention"
                ? "mt-0.5 break-words text-[11px] font-medium leading-snug text-amber-700 dark:text-amber-300"
                : "mt-0.5 break-words text-[11px] leading-snug text-muted-foreground"
            }
          >
            {qualityReviewCopy(review.state, deliveryBlockReason(r))}
          </p>
          {review.note && (
            <p className="mt-0.5 break-words text-[10.5px] leading-snug text-muted-foreground" title="Note from the automated visual check - advisory only">
              {review.note}
            </p>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
        {!r.supersededAt && r.aspectVerdict === "mismatch" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onRegenerate(r.id)}
            disabled={regenFor !== null || varyFor !== null || active}
            aria-busy={regenFor === r.id}
            title="Generate this stage again for the planned placement - a new paid run; nothing retries automatically"
            className="h-7 rounded-full px-2.5 text-[11px]"
          >
            {regenFor === r.id ? "Regenerating…" : `Regenerate ${r.format}`}
          </Button>
        )}
        {(() => {
          // Explicit variations only from a completed stored image:
          // the server re-verifies before dispatch. Cost is stated
          // in the confirm dialog, never silently incurred.
          if (!canVary) return null;
          return (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onRequestVary(r.id)}
              // A regeneration uses its own queued job. A different,
              // completed asset can still start an explicitly requested
              // variation; server-side concurrency and spend gates remain
              // authoritative. Only prevent duplicate local submissions.
              disabled={varyFor !== null || regenFor === r.id}
              aria-busy={varyFor === r.id}
              title="Derive 2 additional image assets from this completed output as new paid runs - the original stays intact"
              className="h-7 rounded-full px-2.5 text-[11px]"
            >
              <Sparkles className="h-3 w-3" aria-hidden />
              {varyFor === r.id ? "Starting…" : "Create variations"}
            </Button>
          );
        })()}
        </div>
        <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-0.5">
        {verificationRef ? (
          <Link href={`/verify/${verificationRef}#output-${r.id}`} className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-700 hover:underline dark:text-sky-300">
            Verify <ArrowRight className="h-3 w-3" />
          </Link>
        ) : (
          <span className="text-[11px] text-muted-foreground" title="Approve the pack to publish its verification link">
            Verify after approval
          </span>
        )}
        {(() => {
          const dl = downloadHrefFor(r.outputUrl, r.storageUrl);
          return (
            <a
              href={dl.href}
              target="_blank"
              rel="noreferrer"
              download={dl.attachment ? true : undefined}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              title={dl.attachment ? "Download the stored file" : "Open the original in a new tab to save it"}
            >
              <Download className="h-3 w-3" /> Download
            </a>
          );
        })()}
        </span>
      </div>
    </div>
  );
}
