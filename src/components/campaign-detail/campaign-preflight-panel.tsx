"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface CampaignPreflightPanelProps {
  checking: boolean;
  disabled: boolean;
  status: string | null;
  onRun: () => void;
}

/** Initial permission-check prompt. Display only - the route owns the check. */
export function CampaignPreflightPanel({ checking, disabled, status, onRun }: CampaignPreflightPanelProps) {
  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-6 dark:border-amber-900 dark:bg-amber-950/30">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-800 dark:text-amber-300">Ready for permission check</p>
      <h2 className="mt-2 text-[16px] font-semibold">Run the permission check before production</h2>
      <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">Running this check verifies creator rights and brand rules, then records the decision for this campaign.</p>
      <Button
        size="sm"
        onClick={onRun}
        disabled={disabled}
        aria-busy={checking}
        className="mt-4 rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
      >
        <RefreshCw className={cn("h-3.5 w-3.5", checking && "animate-spin")} aria-hidden /> {checking ? "Checking permissions…" : "Run permission check"}
      </Button>
      {checking && status && (
        <p role="status" className="mt-3 max-w-2xl text-[13px] leading-relaxed text-emerald-700 dark:text-emerald-300">{status}</p>
      )}
    </section>
  );
}
