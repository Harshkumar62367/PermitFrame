"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { SectionCard } from "@/components/ui/section-card";
import { apiGet } from "@/lib/api";
import type { DkgHealth } from "@/server/dkg/adapter";

interface CapabilitiesResponse {
  ok: boolean;
  capabilities?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
  error?: string;
}

type CapsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; at: string; capabilities: Record<string, unknown>; pricing: Record<string, unknown> }
  | { status: "failed"; at: string; error: string };

export default function SettingsPage() {
  const [health, setHealth] = useState<{ dkg: DkgHealth; livepeer: { endpoint: string; keyless: boolean; reachable?: boolean; detail?: string } } | null>(null);
  const [caps, setCaps] = useState<CapsState>({ status: "idle" });

  useEffect(() => {
    const controller = new AbortController();
    apiGet<{ dkg: DkgHealth; livepeer: { endpoint: string; keyless: boolean; reachable?: boolean; detail?: string } }>("/api/health", controller.signal)
      .then(setHealth)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  async function checkLivepeer() {
    if (caps.status === "loading") return;
    setCaps({ status: "loading" });
    const startedAt = new Date();
    try {
      const res = await apiGet<CapabilitiesResponse>("/api/livepeer");
      if (!res.ok) throw new Error(res.error ?? "Livepeer agent did not answer.");
      setCaps({
        status: "ready",
        at: startedAt.toLocaleString(),
        capabilities: (res.capabilities ?? {}) as Record<string, unknown>,
        pricing: (res.pricing ?? {}) as Record<string, unknown>
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

  return (
    <div className="pf-page space-y-6">
      <div>
        <PageHeader
          eyebrow="System"
          title="Settings"
          description="Integration health for the two networks PermitFrame runs on."
          width="narrow"
        />
      </div>

      <div>
        <div className="grid max-w-3xl gap-4 md:grid-cols-2">
          <SectionCard title="OriginTrail DKG">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[11px] text-muted-foreground">mode</span>
              <Badge variant="outline" className={health?.dkg.mode === "edge-node" ? "rounded-full bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800" : "rounded-full bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800"}>
                {health?.dkg.mode ?? "checking"}
              </Badge>
            </div>
            <p className="mt-2.5 break-words text-[12.5px] leading-relaxed text-muted-foreground">{health?.dkg.detail ?? "Checking DKG diagnostics in the background. Workspace data does not depend on this check."}</p>
            <p className="mt-3 break-words font-mono text-[10.5px] text-muted-foreground">
              blockchain: {health?.dkg.blockchain ?? "—"} · use DKG_MODE=edge for the OriginTrail DKG V10 Edge Node
            </p>
          </SectionCard>
          <SectionCard title="Livepeer Agent">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[11px] text-muted-foreground">auth</span>
              <Badge variant="outline" className="rounded-full bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800">
                {health?.livepeer.keyless ? "hosted access" : health ? "api key" : "checking"}
              </Badge>
            </div>
            <p className="mt-2.5 break-all font-mono text-[11.5px] leading-relaxed text-muted-foreground">{health?.livepeer.endpoint ?? "Loading integration details…"}</p>
            {health?.livepeer.detail && (
              <p className="mt-2 break-words text-[12.5px] leading-relaxed text-muted-foreground">{health.livepeer.detail}</p>
            )}
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
                Contacting the Livepeer agent (list_capabilities + get_pricing)…
              </p>
            )}
            {caps.status === "ready" && (
              <div role="status" className="mt-2 space-y-1 font-mono text-[10.5px]">
                <p className="text-emerald-700 dark:text-emerald-300">
                  Reachable — {capCount} {capCount === 1 ? "capability" : "capabilities"}, {priceCount} pricing {priceCount === 1 ? "entry" : "entries"}.
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
        </div>
      </div>
    </div>
  );
}
