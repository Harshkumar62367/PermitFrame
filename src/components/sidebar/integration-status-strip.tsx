"use client";

import { useRef, useState } from "react";
import { IntegrationStatusPopover } from "./integration-status-popover";
import { cn } from "@/lib/utils";

export interface StripHealth {
  dkg: { mode: string; healthy: boolean; blockchain?: string; detail?: string; endpoint?: string };
  livepeer: { keyless: boolean; endpoint?: string; reachable?: boolean; detail?: string };
}

type DotState = "loading" | "healthy" | "degraded" | "down";

function dotClass(state: DotState): string {
  if (state === "healthy") return "bg-emerald-500 dark:bg-emerald-400";
  if (state === "degraded") return "bg-amber-500 dark:bg-amber-400";
  if (state === "down") return "bg-rose-500 dark:bg-rose-400";
  return "animate-pulse bg-muted-foreground/40 dark:bg-white/25";
}

/**
 * Slim services strip in producer language: Proof ledger and Asset
 * production. Opens an explanatory popover — a red dot is never left
 * unexplained, and production is never shown healthy without a real
 * reachability signal.
 */
export function IntegrationStatusStrip({
  health,
  collapsed = false,
  onNavigate
}: {
  health: StripHealth | null;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Production health is unknown until the first real probe answers: render a
  // neutral checking state rather than an assumed green.
  const dkg: DotState = !health ? "loading" : health.dkg.healthy ? "healthy" : "down";
  const livepeer: DotState =
    !health || health.livepeer.reachable === undefined ? "loading" : health.livepeer.reachable ? "healthy" : "down";
  const degraded = dkg === "down" || livepeer === "down";

  const dkgShort = !health ? "checking" : health.dkg.healthy ? "healthy" : "degraded — open for why";
  const livepeerShort = !health || health.livepeer.reachable === undefined ? "checking" : health.livepeer.reachable ? "healthy" : "degraded — open for why";
  const label = `Services: proof ledger ${dkgShort}; asset production ${livepeerShort}. Open service status.`;

  const popover = (
    <IntegrationStatusPopover
      open={open}
      onClose={() => setOpen(false)}
      onNavigate={onNavigate}
      triggerRef={triggerRef}
      health={health}
      rail={collapsed}
    />
  );

  if (collapsed) {
    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={label}
          title={label}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-xl transition hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
        >
          <span className={cn("h-2 w-2 rounded-full", dotClass(dkg))} aria-hidden />
          <span className={cn("h-2 w-2 rounded-full", dotClass(livepeer))} aria-hidden />
        </button>
        {popover}
      </>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={label}
        title={label}
        className="pf-side-strip flex w-full flex-col justify-center gap-1 rounded-xl border border-border bg-muted/40 px-3.5 py-2 text-[11.5px] transition hover:bg-muted/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:border-white/[0.07] dark:bg-white/[0.03]"
      >
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className={cn("h-2 w-2 shrink-0 rounded-full", dotClass(dkg))} aria-hidden />
          <span className="truncate font-medium text-foreground/80 dark:text-white/70">
            Proof ledger{degraded && dkg === "down" ? " · degraded" : ""}
          </span>
        </span>
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className={cn("h-2 w-2 shrink-0 rounded-full", dotClass(livepeer))} aria-hidden />
          <span className="truncate font-medium text-foreground/80 dark:text-white/70">
            Asset production{degraded && livepeer === "down" ? " · degraded" : ""}
          </span>
        </span>
      </button>
      {popover}
    </>
  );
}
