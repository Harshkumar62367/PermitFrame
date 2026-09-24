"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { HEALTH_SLOW_COPY } from "@/lib/use-integration-health";
import { SidebarPopover } from "./sidebar-popover";
import { useWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import type { StripHealth } from "./integration-status-strip";
import { cn } from "@/lib/utils";

function lastGenerationLabel(activity: { kind: string; at: string }[] | undefined): string | null {
  if (!activity) return null;
  const last = activity.find((a) => a.kind === "production.run" || a.kind === "dkg.publish");
  if (!last) return "No productions recorded yet";
  const date = new Date(last.at);
  return Number.isNaN(date.getTime()) ? null : `Last completed production ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function lastEvidenceLabel(activity: { kind: string; at: string }[] | undefined): string | null {
  if (!activity) return null;
  const last = activity.find((a) =>
    ["dkg.publish", "facts.updated", "media.registered", "passport.revoked", "passport.renewed", "campaign.approved"].includes(a.kind)
  );
  if (!last) return "No proof records yet";
  const date = new Date(last.at);
  return Number.isNaN(date.getTime()) ? null : `Last evidence activity ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/**
 * What each network actually does for the agency, with honest health detail.
 * Missing data is labelled as missing - never a green dot on an unknown state.
 */
export function IntegrationStatusPopover({
  open,
  onClose,
  onNavigate,
  triggerRef,
  health,
  rail = false,
  isSlow = false,
  onRetry
}: {
  open: boolean;
  onClose: () => void;
  onNavigate?: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  health: StripHealth | null;
  rail?: boolean;
  isSlow?: boolean;
  onRetry?: () => void;
}) {
  const snapshot = useWorkspaceSnapshot();
  const activity = snapshot.data?.activity;

  const dkg = health?.dkg ?? null;
  const livepeer = health?.livepeer ?? null;
  const dkgName = !dkg ? "Proof ledger" : dkg.mode === "edge-node" ? "Proof ledger (shared)" : "Proof ledger (this workspace)";
  // The server reports an explicit state: "checking" (no probe has settled
  // yet) is neutral copy, never a red Degraded. Degraded means a real failure.
  // The `=== null` checks keep TypeScript narrowing intact below.
  const dkgPending = dkg === null || dkg.state === "checking";
  const livepeerPending = livepeer === null || livepeer.state === "checking";
  // Slow stays neutral: a "Slow" badge with muted checking styling, never a
  // red Degraded, and the exact slow copy instead of the checking copy.
  const dkgSlow = isSlow && dkgPending;
  const livepeerSlow = isSlow && livepeerPending;
  const dkgState = dkgSlow ? "Slow" : dkgPending ? "Checking…" : dkg.healthy ? "Healthy" : "Degraded";
  const livepeerState = livepeerSlow ? "Slow" : livepeerPending ? "Checking…" : livepeer.reachable ? "Healthy" : "Degraded";
  const dkgCopy = dkgSlow
    ? HEALTH_SLOW_COPY
    : dkgPending
      ? "Checking service health - permission-check evidence will cite the exact proof records it used."
      : dkg.mode === "edge-node" && dkg.healthy
        ? "Shared proof ledger connected - approvals can publish public verification."
        : dkg.mode === "edge-node"
          ? "Shared proof ledger unreachable - campaigns keep working with workspace records."
          : "Workspace proof records - public verification needs the shared ledger (Settings › Advanced).";
  const livepeerCopy = livepeerSlow
    ? HEALTH_SLOW_COPY
    : (livepeer?.detail ?? "Checking service health - only approved campaigns may start production jobs.");

  return (
    <SidebarPopover
      open={open}
      onClose={onClose}
      label="Service status"
      triggerRef={triggerRef}
      className={rail ? "left-[88px] top-16" : "left-[264px] top-32"}
    >
      <div className="space-y-1 p-2">
        <div className="px-2.5 pb-1 pt-2">
          <p className="text-[13.5px] font-semibold tracking-tight text-foreground dark:text-white">Services</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground dark:text-white/55">
            Who produces the media, and who holds the proof.
          </p>
        </div>

        <div className="rounded-xl bg-muted/50 px-3 py-2.5 ring-1 ring-border dark:ring-white/10">
          <p className="flex items-center justify-between gap-2 text-[12.5px] font-semibold text-foreground dark:text-white">
            Proof ledger
            <span
              className={cn(
                "rounded-full px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em]",
                dkgPending && "bg-muted text-muted-foreground",
                !dkgPending && dkg?.healthy && "bg-emerald-600/10 text-emerald-700 dark:text-emerald-300",
                !dkgPending && dkg && !dkg.healthy && "bg-rose-600/10 text-rose-700 dark:text-rose-300"
              )}
            >
              {dkgState}
            </span>
          </p>
          <p className="mt-0.5 font-mono text-[10.5px] text-muted-foreground dark:text-white/50">{dkgName}</p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground dark:text-white/65">
            {dkgCopy}
          </p>
          {lastEvidenceLabel(activity) && (
            <p className="mt-1 text-[11.5px] text-muted-foreground dark:text-white/55">{lastEvidenceLabel(activity)}</p>
          )}
        </div>

        <div className="rounded-xl bg-muted/50 px-3 py-2.5 ring-1 ring-border dark:ring-white/10">
          <p className="flex items-center justify-between gap-2 text-[12.5px] font-semibold text-foreground dark:text-white">
            Asset production
            <span
              className={cn(
                "rounded-full px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em]",
                livepeerPending && "bg-muted text-muted-foreground",
                !livepeerPending && livepeer?.reachable && "bg-emerald-600/10 text-emerald-700 dark:text-emerald-300",
                !livepeerPending && livepeer && !livepeer.reachable && "bg-rose-600/10 text-rose-700 dark:text-rose-300"
              )}
            >
              {livepeerState}
            </span>
          </p>
          <p className="mt-0.5 font-mono text-[10.5px] text-muted-foreground dark:text-white/50">Production service</p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground dark:text-white/65">
            {livepeerCopy}
          </p>
          {lastGenerationLabel(activity) && (
            <p className="mt-1 text-[11.5px] text-muted-foreground dark:text-white/55">{lastGenerationLabel(activity)}</p>
          )}
        </div>

        <Link
          href="/settings"
          onClick={onNavigate}
          className="mt-1 inline-flex items-center gap-1 px-2.5 py-2 text-[12.5px] font-medium text-emerald-700 hover:underline dark:text-emerald-300"
        >
          Open settings for services and retries <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
        {(dkgSlow || livepeerSlow) && onRetry && (
          <div className="px-2.5 pb-1">
            <button
              type="button"
              onClick={onRetry}
              className="rounded-full px-2.5 py-1 text-[12.5px] font-medium text-emerald-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:text-emerald-300"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </SidebarPopover>
  );
}
