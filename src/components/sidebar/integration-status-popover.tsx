"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { SidebarPopover } from "./sidebar-popover";
import { useWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import type { StripHealth } from "./integration-status-strip";
import { cn } from "@/lib/utils";

function lastGenerationLabel(activity: { kind: string; at: string }[] | undefined): string | null {
  if (!activity) return null;
  const last = activity.find((a) => a.kind === "production.run" || a.kind === "dkg.publish");
  if (!last) return "No generations recorded yet";
  const date = new Date(last.at);
  return Number.isNaN(date.getTime()) ? null : `Last successful generation ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function lastEvidenceLabel(activity: { kind: string; at: string }[] | undefined): string | null {
  if (!activity) return null;
  const last = activity.find((a) =>
    ["dkg.publish", "facts.updated", "media.registered", "passport.revoked", "passport.renewed", "campaign.approved"].includes(a.kind)
  );
  if (!last) return "No publications recorded yet";
  const date = new Date(last.at);
  return Number.isNaN(date.getTime()) ? null : `Last evidence activity ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/**
 * What each network actually does for the agency, with honest health detail.
 * Missing data is labelled as missing — never a green dot on an unknown state.
 */
export function IntegrationStatusPopover({
  open,
  onClose,
  onNavigate,
  triggerRef,
  health,
  rail = false
}: {
  open: boolean;
  onClose: () => void;
  onNavigate?: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  health: StripHealth | null;
  rail?: boolean;
}) {
  const snapshot = useWorkspaceSnapshot();
  const activity = snapshot.data?.activity;

  const dkg = health?.dkg ?? null;
  const livepeer = health?.livepeer ?? null;
  const dkgName = !dkg ? "Evidence network" : dkg.mode === "edge-node" ? "OriginTrail DKG V10 (edge node)" : "Local evidence mode";
  const dkgState = !dkg ? "Checking…" : dkg.healthy ? "Healthy" : "Degraded";
  const livepeerState = !livepeer ? "Checking…" : livepeer.reachable ? "Healthy" : "Degraded";

  return (
    <SidebarPopover
      open={open}
      onClose={onClose}
      label="Integration status"
      triggerRef={triggerRef}
      className={rail ? "left-[88px] top-16" : "left-[264px] top-32"}
    >
      <div className="space-y-1 p-2">
        <div className="px-2.5 pb-1 pt-2">
          <p className="text-[13.5px] font-semibold tracking-tight text-foreground dark:text-white">Integrations</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground dark:text-white/55">
            Who produces the media, and who holds the proof.
          </p>
        </div>

        <div className="rounded-xl bg-muted/50 px-3 py-2.5 ring-1 ring-border dark:ring-white/10">
          <p className="flex items-center justify-between gap-2 text-[12.5px] font-semibold text-foreground dark:text-white">
            Evidence network
            <span
              className={cn(
                "rounded-full px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em]",
                !dkg && "bg-muted text-muted-foreground",
                dkg?.healthy && "bg-emerald-600/10 text-emerald-700 dark:text-emerald-300",
                dkg && !dkg.healthy && "bg-rose-600/10 text-rose-700 dark:text-rose-300"
              )}
            >
              {dkgState}
            </span>
          </p>
          <p className="mt-0.5 font-mono text-[10.5px] text-muted-foreground dark:text-white/50">{dkgName}</p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground dark:text-white/65">
            {dkg?.detail ?? "Checking integration health — preflight evidence will cite the exact Knowledge Assets it used."}
          </p>
          {dkg?.blockchain && (
            <p className="mt-1 font-mono text-[10.5px] text-muted-foreground dark:text-white/50">{dkg.blockchain}</p>
          )}
          {dkg?.endpoint && (
            <p className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground dark:text-white/50" title={dkg.endpoint}>
              {dkg.endpoint}
            </p>
          )}
          {lastEvidenceLabel(activity) && (
            <p className="mt-1 text-[11.5px] text-muted-foreground dark:text-white/55">{lastEvidenceLabel(activity)}</p>
          )}
        </div>

        <div className="rounded-xl bg-muted/50 px-3 py-2.5 ring-1 ring-border dark:ring-white/10">
          <p className="flex items-center justify-between gap-2 text-[12.5px] font-semibold text-foreground dark:text-white">
            Generation network
            <span
              className={cn(
                "rounded-full px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em]",
                !livepeer && "bg-muted text-muted-foreground",
                livepeer?.reachable && "bg-emerald-600/10 text-emerald-700 dark:text-emerald-300",
                livepeer && !livepeer.reachable && "bg-rose-600/10 text-rose-700 dark:text-rose-300"
              )}
            >
              {livepeerState}
            </span>
          </p>
          <p className="mt-0.5 font-mono text-[10.5px] text-muted-foreground dark:text-white/50">Livepeer Agent</p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground dark:text-white/65">
            {livepeer?.detail ?? "Checking integration health — only preflight-approved campaigns may start production jobs."}
          </p>
          {livepeer?.endpoint && (
            <p className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground dark:text-white/50" title={livepeer.endpoint}>
              {livepeer.endpoint} · {livepeer.keyless ? "hosted access" : "API key"}
            </p>
          )}
          {lastGenerationLabel(activity) && (
            <p className="mt-1 text-[11.5px] text-muted-foreground dark:text-white/55">{lastGenerationLabel(activity)}</p>
          )}
        </div>

        <Link
          href="/settings"
          onClick={onNavigate}
          className="mt-1 inline-flex items-center gap-1 px-2.5 py-2 text-[12.5px] font-medium text-emerald-700 hover:underline dark:text-emerald-300"
        >
          Open settings for endpoints and retries <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
    </SidebarPopover>
  );
}
