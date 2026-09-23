"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { SectionCard } from "@/components/ui/section-card";
import { apiGet } from "@/lib/api";
import { HEALTH_SLOW_COPY, useIntegrationHealth } from "@/lib/use-integration-health";

interface CapabilitiesResponse {
  ok: boolean;
  capabilities?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
  roles?: { image: string | null; motion: string | null };
  authMode?: "bearer-key" | "keyless-hosted";
  checkedAt?: string;
  error?: string;
}

type CapsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; at: string; capabilities: Record<string, unknown>; pricing: Record<string, unknown>; roles: { image: string | null; motion: string | null } | null; authMode: string | null; checkedAt: string | null }
  | { status: "failed"; at: string; error: string };

export default function SettingsPage() {
  const { health, isSlow, retry } = useIntegrationHealth();
  const [caps, setCaps] = useState<CapsState>({ status: "idle" });
  const [storage, setStorage] = useState<{ configured: boolean; reachable: boolean; detail: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiGet<{ configured: boolean; reachable: boolean; detail: string }>("/api/storage/health", controller.signal)
      .then(setStorage)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  async function checkLivepeer() {
    if (caps.status === "loading") return;
    setCaps({ status: "loading" });
    const startedAt = new Date();
    try {
      const res = await apiGet<CapabilitiesResponse>("/api/livepeer");
      if (!res.ok) throw new Error(res.error ?? "Production service did not answer.");
      setCaps({
        status: "ready",
        at: startedAt.toLocaleString(),
        capabilities: (res.capabilities ?? {}) as Record<string, unknown>,
        pricing: (res.pricing ?? {}) as Record<string, unknown>,
        roles: res.roles ?? null,
        authMode: res.authMode ?? null,
        checkedAt: res.checkedAt ?? null
      });
    } catch (e) {
      setCaps({
        status: "failed",
        at: startedAt.toLocaleString(),
        error: e instanceof Error ? e.message : "Capability check failed."
      });
    }
  }

  const capCount = caps.status === "ready" ? Object.keys(caps.capabilities).length : null;
  const priceCount = caps.status === "ready" ? Object.keys(caps.pricing).length : null;
  const dkgPending = !health || health.dkg.state === "checking";
  const livepeerPending = !health || health.livepeer.state === "checking";
  // Slow is neutral: badges stay muted, never red, and copy is the exact
  // slow-check wording. Settled Healthy/Degraded/Unavailable always wins.
  const showSlow = isSlow && (dkgPending || livepeerPending);

  return (
    <div className="pf-page space-y-6">
      <div>
        <PageHeader
          eyebrow="System"
          title="Settings"
          description="Connections for the services PermitFrame runs on, plus advanced evidence tools."
          width="narrow"
        />
      </div>

      <div>
        <div className="grid max-w-3xl gap-4 md:grid-cols-2">
          {showSlow && (
            <div role="status" className="rounded-xl bg-muted/50 p-3 ring-1 ring-border md:col-span-2">
              <p className="text-[12.5px] leading-relaxed text-muted-foreground">{HEALTH_SLOW_COPY}</p>
              <Button variant="outline" size="sm" onClick={retry} className="mt-2 h-7 rounded-full px-2.5 text-[11.5px]">
                Retry
              </Button>
            </div>
          )}
          <SectionCard title="Proof ledger">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[11px] text-muted-foreground">mode</span>
              <Badge variant="outline" className={health?.dkg.mode === "edge-node" ? "rounded-full bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800" : "rounded-full bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800"}>
                {health ? (health.dkg.mode === "edge-node" ? "shared ledger" : "workspace only") : showSlow ? "Slow" : "checking"}
              </Badge>
            </div>
            <p className="mt-2.5 break-words text-[12.5px] leading-relaxed text-muted-foreground">
              {!health || health.dkg.state === "checking"
                ? showSlow
                  ? HEALTH_SLOW_COPY
                  : "Checking proof-ledger diagnostics in the background. Workspace data does not depend on this check."
                : health.dkg.mode === "edge-node" && health.dkg.healthy
                  ? "Shared proof ledger connected - approvals can publish public verification."
                  : health.dkg.mode === "edge-node"
                    ? "Shared proof ledger unreachable - campaigns keep working with workspace records."
                    : "Workspace proof records. Connect the shared ledger in Advanced evidence below for public verification."}
            </p>
          </SectionCard>
          <SectionCard title="Asset production">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[11px] text-muted-foreground">auth</span>
              <Badge variant="outline" className="rounded-full bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800">
                {health?.livepeer.keyless ? "hosted access" : health ? "api key" : showSlow ? "Slow" : "checking"}
              </Badge>
            </div>
            <p className="mt-2.5 break-all font-mono text-[11.5px] leading-relaxed text-muted-foreground">{health?.livepeer.endpoint ?? "Loading integration details…"}</p>
            {health?.livepeer.detail ? (
              <p className="mt-2 break-words text-[12.5px] leading-relaxed text-muted-foreground">{health.livepeer.detail}</p>
            ) : (
              livepeerPending && showSlow && (
                <p role="status" className="mt-2 break-words text-[12.5px] leading-relaxed text-muted-foreground">{HEALTH_SLOW_COPY}</p>
              )
            )}
            <div className="mt-2.5 rounded-xl bg-muted/50 p-3 ring-1 ring-border">
              <p className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">Campaign roles · live discovery</p>
              {caps.status === "ready" && caps.roles ? (
                <div className="mt-1.5 space-y-1 font-mono text-[11px]">
                  <p>keyframe + variations → <span className="text-foreground">{caps.roles.image ?? "no verified pick"}</span></p>
                  <p>motion asset → <span className="text-foreground">{caps.roles.motion ?? "no verified pick"}</span></p>
                  <p className="text-muted-foreground">
                    {caps.authMode === "bearer-key" ? "API key" : "hosted access"}
                    {caps.checkedAt ? ` · checked ${new Date(caps.checkedAt).toLocaleString()}` : ""}
                  </p>
                </div>
              ) : (
                <p className="mt-1.5 text-[11.5px] text-muted-foreground">
                  Run the capability check below - roles are mapped only from capabilities the Livepeer server reports as available.
                </p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={checkLivepeer}
              disabled={caps.status === "loading"}
              aria-busy={caps.status === "loading"}
              className="mt-3 rounded-full"
            >
              {caps.status === "loading" ? "Checking…" : caps.status === "idle" ? "Check capabilities & pricing" : "Check again"}
            </Button>
            {caps.status === "loading" && (
              <p role="status" className="mt-2 font-mono text-[10.5px] text-muted-foreground">
                Contacting the production service…
              </p>
            )}
            {caps.status === "ready" && (
              <div role="status" className="mt-2 space-y-1 font-mono text-[10.5px]">
                <p className="text-emerald-700 dark:text-emerald-300">
                  Reachable - {capCount} {capCount === 1 ? "capability" : "capabilities"}, {priceCount} pricing {priceCount === 1 ? "entry" : "entries"}.
                </p>
                <p className="text-muted-foreground">Checked {caps.at}.</p>
                {capCount !== null && capCount > 0 && (
                  <p className="break-words text-muted-foreground">Capabilities: {Object.keys(caps.capabilities).join(", ")}</p>
                )}
              </div>
            )}
            {caps.status === "failed" && (
              <div className="mt-2 space-y-1.5">
                <p role="alert" className="break-words font-mono text-[10.5px] text-rose-600 dark:text-rose-300">
                  Unreachable ({caps.at}): {caps.error}
                </p>
                <Button variant="ghost" size="sm" onClick={checkLivepeer} className="h-7 rounded-full px-2.5 text-[11.5px]">
                  Retry check
                </Button>
              </div>
            )}
          </SectionCard>
          <SectionCard title="Durable storage">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[11px] text-muted-foreground">provider</span>
              <Badge variant="outline" className="rounded-full bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800">
                {!storage ? "checking" : storage.configured ? "PermitFrame storage" : "not configured"}
              </Badge>
            </div>
            <p className="mt-2 break-words text-[12.5px] leading-relaxed text-muted-foreground">
              {!storage
                ? "Loading storage status…"
                : storage.detail}
            </p>
            {storage?.configured && !storage.reachable && (
              <p className="mt-1.5 text-[12px] text-amber-700 dark:text-amber-300">
                Completed outputs wait as storage-pending with provider results intact - no proof is published for undelivered assets.
              </p>
            )}
          </SectionCard>
        </div>
      </div>

      <div>
        <SectionCard
          title="Advanced evidence"
          description="Optional technical tooling. Verification covers day-to-day client review."
          actions={
            <Button asChild variant="outline" size="sm" className="h-7 rounded-full px-2.5 text-[11.5px]">
              <Link href="/graph">Open proof inspector <ArrowRight className="h-3 w-3" /></Link>
            </Button>
          }
        >
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            The proof inspector shows the underlying proof records and a query console for diagnosing
            evidence issues. Most producers never need it.
          </p>
        </SectionCard>
      </div>
    </div>
  );
}
