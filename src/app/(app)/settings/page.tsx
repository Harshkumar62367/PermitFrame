"use client";

import { useEffect, useState } from "react";
import { FadeIn } from "@/components/motion-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface CapabilitiesResponse {
  ok: boolean;
  capabilities?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
  error?: string;
}

export default function SettingsPage() {
  const [boot, setBoot] = useState<{ dkg: { mode: string; healthy: boolean; detail: string; blockchain?: string }; livepeer: { endpoint: string; keyless: boolean } } | null>(null);
  const [caps, setCaps] = useState<CapabilitiesResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/bootstrap")
      .then((r) => (r.ok ? r.json() : null))
      .then(setBoot)
      .catch(() => undefined);
  }, []);

  function checkLivepeer() {
    setLoading(true);
    fetch("/api/livepeer")
      .then((r) => r.json())
      .then(setCaps)
      .catch(() => setCaps({ ok: false, error: "request failed" }))
      .finally(() => setLoading(false));
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-emerald-700">System</p>
        <h1 className="font-display mt-1.5 text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1.5 text-[13.5px] text-muted-foreground">Integration health for the two networks PermitFrame runs on.</p>
      </FadeIn>

      {boot && (
        <FadeIn delay={0.05}>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-border bg-card p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-[14px] font-semibold">OriginTrail DKG</h2>
                <Badge variant="outline" className={boot.dkg.mode === "dkg-testnet" ? "rounded-full bg-emerald-50 text-emerald-700 ring-emerald-600/20" : "rounded-full bg-amber-50 text-amber-700 ring-amber-600/20"}>
                  {boot.dkg.mode}
                </Badge>
              </div>
              <p className="mt-2.5 text-[12.5px] leading-relaxed text-muted-foreground">{boot.dkg.detail}</p>
              <p className="mt-3 font-mono text-[10.5px] text-muted-foreground">
                blockchain: {boot.dkg.blockchain ?? "—"} · switch with DKG_MODE=real + DKG_ENDPOINT + DKG_PRIVATE_KEY
              </p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-[14px] font-semibold">Livepeer Agent</h2>
                <Badge variant="outline" className="rounded-full bg-emerald-50 text-emerald-700 ring-emerald-600/20">
                  {boot.livepeer.keyless ? "keyless demo credit" : "api key"}
                </Badge>
              </div>
              <p className="mt-2.5 font-mono text-[11.5px] leading-relaxed text-muted-foreground">{boot.livepeer.endpoint}</p>
              <Button variant="outline" size="sm" onClick={checkLivepeer} disabled={loading} className="mt-3 rounded-full">
                {loading ? "Checking…" : "Check capabilities & pricing"}
              </Button>
              {caps && (
                <p className={`mt-2 font-mono text-[10.5px] ${caps.ok ? "text-emerald-700" : "text-rose-600"}`}>
                  {caps.ok ? "MCP reachable — list_capabilities + get_pricing succeeded" : `unreachable: ${caps.error?.slice(0, 120)}`}
                </p>
              )}
            </div>
          </div>
        </FadeIn>
      )}
    </div>
  );
}
