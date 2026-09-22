import Link from "next/link";
import { ArrowRight, Download, Maximize2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { describeActualSize } from "@/server/livepeer/aspect";
import { preservationIndicator } from "@/lib/preservation";
import { downloadHrefFor } from "@/lib/proof-links";
import type { DerivativeReceipt } from "@/server/types";

interface ReviewAssetCardProps {
  receipt: DerivativeReceipt;
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
  return (
    <div className="group overflow-hidden rounded-xl bg-muted/60 ring-1 ring-border transition hover:ring-emerald-600/40">
      {r.mediaType === "image" ? (
        <button
          type="button"
          onClick={() => onOpen(index)}
          title={`${r.label} — click to view full size`}
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
            className="aspect-[3/4] w-full bg-black object-cover"
          />
          <button
            type="button"
            onClick={() => onOpen(index)}
            title={`${r.label} — click to view full size`}
            aria-label={`View ${r.label} full size`}
            className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-black/60 text-white opacity-0 transition hover:bg-black/80 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      )}
      <div className="space-y-1 p-3">
        <p className="text-[12.5px] font-medium leading-tight">{r.label}</p>
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
        {(() => {
          // What actually ran, not what was planned: compact pill,
          // full sentence on hover. Legacy rows without preservation
          // fields normalize to no claim and render nothing here.
          const ind = preservationIndicator(r);
          if (!ind.label) return null;
          return (
            <p className="text-[10.5px] font-medium text-muted-foreground" title={ind.detail}>
              {ind.label}
              {ind.fallbackUsed && <span className="text-amber-700 dark:text-amber-300"> · fallback used</span>}
            </p>
          );
        })()}
        {r.aspectVerdict === "mismatch" && r.actualWidth !== undefined && r.actualHeight !== undefined ? (
          <p role="status" className="break-words text-[11px] font-medium leading-snug text-amber-700 dark:text-amber-300">
            Needs review — requested {r.format}, received {describeActualSize(r.actualWidth, r.actualHeight)}.
          </p>
        ) : (
          <p className="text-[10.5px] text-muted-foreground" title={r.storageStatus === "stored" ? "Persisted to PermitFrame durable storage; the provider original stays on record" : "Provider-hosted legacy output - previewable, but not share-ready until stored securely"}>
            {r.storageStatus === "stored" ? "Stored in PermitFrame" : r.storageStatus === "failed" ? "Storage failed" : "Provider-hosted legacy asset"}
          </p>
        )}
        <div className="mt-1 flex flex-wrap gap-1.5">
        {r.aspectVerdict === "mismatch" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onRegenerate(r.id)}
            disabled={regenFor !== null || varyFor !== null || active}
            aria-busy={regenFor === r.id}
            title="Generate this stage again for the planned placement — a new paid run; nothing retries automatically"
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
              disabled={regenFor !== null || varyFor !== null || active}
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
