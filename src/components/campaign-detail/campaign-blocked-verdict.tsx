"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VerdictCross } from "@/components/motion-primitives";
import { SimulationPanel } from "@/components/studio/simulation-panel";
import type { Campaign } from "@/server/types";
import { cn } from "@/lib/utils";

interface CampaignBlockedVerdictProps {
  decision: NonNullable<Campaign["preflight"]>;
  isArchived: boolean;
  checking: boolean;
  disabled: boolean;
  status: string | null;
  onRecheck: () => void;
  campaignId: string;
}

/** Blocked verdict: reasons plus the exact fix. Display only - the route owns the re-check. */
export function CampaignBlockedVerdict({
  decision,
  isArchived,
  checking,
  disabled,
  status,
  onRecheck,
  campaignId
}: CampaignBlockedVerdictProps) {
  return (
    <div
      id="evidence"
      className="scroll-mt-24 overflow-hidden rounded-2xl border border-rose-200 bg-gradient-to-b from-rose-50/80 to-card dark:border-rose-900 dark:from-rose-950/40"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-inherit px-6 py-4">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-rose-600 text-rose-50">
            <VerdictCross className="h-4 w-4" />
          </span>
          <div>
            <p className="text-[15px] font-semibold text-rose-900 dark:text-rose-200">
              Changes needed before creation
            </p>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-rose-700 dark:text-rose-300/70">
              {decision.blockers.length} precise reason{decision.blockers.length === 1 ? "" : "s"} - no production spend
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {!isArchived && (
            <>
              <Button asChild variant="outline" size="sm" className="rounded-full">
                <Link href="/consents">Fix creator permissions</Link>
              </Button>
              <Button asChild variant="outline" size="sm" className="rounded-full">
                <Link href="/products">Fix brand rules</Link>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onRecheck}
                disabled={disabled}
                aria-busy={checking}
                className="rounded-full"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", checking && "animate-spin")} aria-hidden /> {checking ? "Checking permissions…" : "Re-check rights"}
              </Button>
              {checking && status && (
                <p role="status" className="mt-2 basis-full text-[12.5px] leading-relaxed text-muted-foreground">{status}</p>
              )}
            </>
          )}
        </div>
      </div>

      <div className="px-6 py-5">
        <div className="space-y-2.5">
          {decision.blockers.map((b, i) => (
            <motion.div
              key={b.code + i}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.15 + i * 0.1 }}
              className="flex items-start gap-3 rounded-xl bg-rose-100/60 p-3.5 ring-1 ring-rose-200 dark:bg-rose-950/50 dark:ring-rose-900"
            >
              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-rose-600 text-white"><X className="h-3 w-3" /></span>
              <div>
                <p className="text-[13.5px] font-medium leading-snug text-rose-950 dark:text-rose-100">{b.message}</p>
                <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-rose-700 dark:text-rose-300/70">
                  {b.code} · evidence: {b.evidenceRefs.join(", ") || "no approved rights or brand rules matched"}
                </p>
                <p className="mt-1.5 text-[12px] leading-relaxed text-rose-900/80 dark:text-rose-200/80">
                  Fix: adjust the brief to match the cited rights or brand rules, then re-check. Nothing generates while blocked.
                </p>
              </div>
            </motion.div>
          ))}
        </div>

        <div className="mt-4">
          <SimulationPanel campaignId={campaignId} sparqlPreview={decision.sparqlPreview} />
        </div>
      </div>
    </div>
  );
}
