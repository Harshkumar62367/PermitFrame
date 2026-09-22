"use client";

import Link from "next/link";
import { FadeIn } from "@/components/motion-primitives";
import type { PipelineCount, SnapshotStage } from "@/lib/use-workspace-snapshot";
import { cn } from "@/lib/utils";

const STAGE_FILTER: Record<SnapshotStage, string> = {
  briefed: "briefed",
  "policy-check": "attention",
  ready: "ready",
  generating: "generating",
  delivered: "delivered"
};

/**
 * Read-only production pipeline: real counts at each stage, each linking to
 * the filtered campaigns page. No drag-and-drop - states move through the
 * production workflow, not through this summary.
 */
export function CampaignPipeline({ pipeline }: { pipeline: PipelineCount[] }) {
  const total = pipeline.reduce((sum, p) => sum + p.count, 0);
  return (
    <FadeIn subtle>
      <section aria-label="Campaign pipeline" className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-semibold tracking-tight">Production pipeline</h2>
          <p className="text-[12px] text-muted-foreground">
            {total === 0 ? "No campaigns yet" : `${total} campaign${total === 1 ? "" : "s"} in production`}
          </p>
        </div>
        <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {pipeline.map((entry, i) => (
            <li key={entry.stage} className="relative">
              <Link
                href={`/campaigns?filter=${STAGE_FILTER[entry.stage]}`}
                aria-label={`${entry.label}: ${entry.count} campaigns. Show in campaigns.`}
                className={cn(
                  "block rounded-xl px-3.5 py-3 ring-1 transition hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600",
                  entry.count > 0
                    ? entry.stage === "policy-check"
                      ? "bg-rose-50/70 ring-rose-200 hover:ring-rose-400 dark:bg-rose-950/30 dark:ring-rose-900 dark:hover:ring-rose-700"
                      : "bg-muted/50 ring-border hover:ring-emerald-600/40"
                    : "bg-transparent ring-border/60"
                )}
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      "grid h-5 w-5 shrink-0 place-items-center rounded-full font-mono text-[10px] font-semibold",
                      entry.count > 0
                        ? entry.stage === "policy-check"
                          ? "bg-rose-600 text-white"
                          : "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-emerald-950"
                        : "bg-muted text-muted-foreground"
                    )}
                  >
                    {i + 1}
                  </span>
                  <span className="truncate text-[12.5px] font-medium">{entry.label}</span>
                </span>
                <span className="font-display mt-1 block text-2xl font-semibold tracking-tight">{entry.count}</span>
              </Link>
            </li>
          ))}
        </ol>
      </section>
    </FadeIn>
  );
}
