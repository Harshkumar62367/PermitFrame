import Link from "next/link";
import { ArrowRight, ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { describeActualSize } from "@/server/livepeer/aspect";
import { downloadHrefFor } from "@/lib/proof-links";
import type { DerivativeReceipt } from "@/server/types";

interface ReviewLightboxProps {
  receipt: DerivativeReceipt;
  index: number;
  total: number;
  verificationRef: string | null;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}

/**
 * Full-size output viewer at the true aspect ratio, with prev/next
 * navigation and evidence links. View-only: selection (which receipt,
 * keyboard traversal) is owned entirely by the parent - this only
 * renders the given receipt and reports button presses back.
 */
export function ReviewLightbox({ receipt, index, total, verificationRef, onClose, onPrev, onNext }: ReviewLightboxProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${receipt.label} - full size viewer`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-card ring-1 ring-border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold">{receipt.label}</p>
            <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              {receipt.format}
              {receipt.actualWidth !== undefined && receipt.actualHeight !== undefined &&
                ` · ${receipt.actualWidth}×${receipt.actualHeight}`}
              {" · "}{receipt.capability}
              {total > 1 && ` · ${index + 1} of ${total}`}
            </p>
            {receipt.aspectVerdict === "mismatch" &&
              receipt.actualWidth !== undefined &&
              receipt.actualHeight !== undefined && (
                <p role="status" className="mt-0.5 text-[11.5px] font-medium text-amber-700 dark:text-amber-300">
                  Needs review - requested {receipt.format}, received {describeActualSize(receipt.actualWidth, receipt.actualHeight)}.
                </p>
              )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close viewer"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="relative flex min-h-0 items-center justify-center bg-black">
          {receipt.mediaType === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={receipt.outputUrl}
              alt={receipt.label}
              className="max-h-[70vh] w-auto max-w-full object-contain"
            />
          ) : (
            <video
              src={receipt.outputUrl}
              controls
              autoPlay
              preload="auto"
              className="max-h-[70vh] w-auto max-w-full object-contain"
            />
          )}
          {total > 1 && (
            <>
              <button
                type="button"
                onClick={onPrev}
                aria-label="Previous output"
                className="absolute left-2 grid h-9 w-9 place-items-center rounded-full bg-black/60 text-white hover:bg-black/80"
              >
                <ChevronLeft className="h-5 w-5" aria-hidden />
              </button>
              <button
                type="button"
                onClick={onNext}
                aria-label="Next output"
                className="absolute right-2 grid h-9 w-9 place-items-center rounded-full bg-black/60 text-white hover:bg-black/80"
              >
                <ChevronRight className="h-5 w-5" aria-hidden />
              </button>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
          {verificationRef ? (
            <Link href={`/verify/${verificationRef}#output-${receipt.id}`} className="inline-flex items-center gap-1 text-[12px] font-medium text-sky-700 hover:underline dark:text-sky-300">
              Verify <ArrowRight className="h-3 w-3" />
            </Link>
          ) : (
            <span className="text-[12px] text-muted-foreground">Verify after approval</span>
          )}
          {(() => {
            const dl = downloadHrefFor(receipt.outputUrl, receipt.storageUrl);
            return (
              <a
                href={dl.href}
                target="_blank"
                rel="noreferrer"
                download={dl.attachment ? true : undefined}
                className="inline-flex items-center gap-1 text-[12px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                <Download className="h-3 w-3" /> Download
              </a>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
