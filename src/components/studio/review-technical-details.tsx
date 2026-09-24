import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { baseSepoliaTransactionUrl, blockExplorerNftUrl } from "@/lib/proof-links";
import type { DerivativeReceipt } from "@/server/types";

interface ReviewTechnicalDetailsProps {
  receipts: Pick<DerivativeReceipt, "id" | "label" | "ual">[];
  campaignRecord: string | null;
  campaignTxHash?: string | null;
  open: boolean;
  onToggle: () => void;
}

/**
 * Collapsible per-receipt UAL list with explorer links for verification.
 * View-only: the open flag and toggle live in the parent.
 */
export function ReviewTechnicalDetails({ receipts, campaignRecord, campaignTxHash, open, onToggle }: ReviewTechnicalDetailsProps) {
  return (
    <div className="mt-4 rounded-xl border border-border p-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[12px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        <ChevronDown className={cn("h-3.5 w-3.5 transition", open && "rotate-180")} aria-hidden />
        Technical details for verification
      </button>
      {open && (
        <div className="mt-3 space-y-2">
          {receipts.map((r) => {
            const nftLink = r.ual ? blockExplorerNftUrl(r.ual) : null;
            return (
              <p key={r.id} className="break-all font-mono text-[10.5px] text-muted-foreground" title={r.ual}>
                <span className="text-foreground">{r.label}</span> · {r.ual}
                {nftLink && (
                  <>
                    {" · "}
                    <a href={nftLink.href} target="_blank" rel="noreferrer" className="font-sans text-sky-700 hover:underline dark:text-sky-300">
                      {nftLink.label}
                    </a>
                  </>
                )}
              </p>
            );
          })}
          {campaignRecord && (
            <p className="break-all font-mono text-[10.5px] text-muted-foreground" title={campaignRecord}>
              Campaign record · {campaignRecord}
              {(() => {
                const nftLink = blockExplorerNftUrl(campaignRecord);
                const transactionLink = baseSepoliaTransactionUrl(campaignRecord, campaignTxHash);
                return nftLink || transactionLink ? (
                  <>
                    {nftLink && (
                      <>
                        {" · "}
                        <a href={nftLink.href} target="_blank" rel="noreferrer" className="font-sans text-sky-700 hover:underline dark:text-sky-300">
                          {nftLink.label}
                        </a>
                      </>
                    )}
                    {transactionLink && (
                      <>
                        {" · "}
                        <a href={transactionLink.href} target="_blank" rel="noreferrer" className="font-sans text-sky-700 hover:underline dark:text-sky-300">
                          {transactionLink.label}
                        </a>
                      </>
                    )}
                  </>
                ) : null;
              })()}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
