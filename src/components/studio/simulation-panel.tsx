"use client";

import { useState } from "react";
import { ChevronDown, Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { COUNTRIES } from "@/lib/countries";
import { AnimatePresence, motion } from "framer-motion";
import { apiPost, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

const PLATFORMS = ["instagram", "tiktok", "youtube", "linkedin"];

interface SimResult {
  decision: string;
  blockers: { code: string; message: string }[];
  allowedClaims: string[];
  plan: unknown[];
}

interface SimulationPanelProps {
  campaignId: string;
  sparqlPreview: string;
}

/**
 * Rights simulator + proof-query disclosure, shared by the blocked view and
 * the studio. What-if only - it never changes the campaign.
 */
export function SimulationPanel({ campaignId, sparqlPreview }: SimulationPanelProps) {
  const [sim, setSim] = useState({ platform: "", country: "", claims: "" });
  const [simResult, setSimResult] = useState<SimResult | null>(null);
  const [simError, setSimError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSparql, setShowSparql] = useState(false);

  async function runSimulation() {
    if (busy) return;
    setSimResult(null);
    setSimError(null);
    setBusy(true);
    try {
      // What-if only: persists nothing, so the default bounded timeout stays
      // (never the 120s mutation policy). Only the timeout wording improves -
      // a slow simulation implies nothing was saved.
      const j = await apiPost<{ decision: SimResult }>(`/api/campaigns/${campaignId}/simulate`, {
        platform: sim.platform || undefined,
        country: sim.country || undefined,
        requestedClaims: sim.claims ? sim.claims.split(",").map((c) => c.trim()).filter(Boolean) : undefined
      });
      setSimResult(j.decision);
    } catch (e) {
      // Simulator inputs are preserved for retry.
      setSimError(
        e instanceof ApiError && e.status === 0
          ? "The permission simulation is taking longer than expected. Try again in a moment."
          : e instanceof Error ? e.message : "Simulation failed. Your inputs are preserved."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="simulate" className="scroll-mt-24 rounded-xl border border-dashed border-border p-4">
      <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        <Gauge className="h-3.5 w-3.5" /> Permission simulator - what-if only, never changes this campaign
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="studio-sim-platform" className="sr-only">Simulated platform</Label>
          <Select value={sim.platform} onValueChange={(v) => setSim((s) => ({ ...s, platform: v }))}>
            <SelectTrigger id="studio-sim-platform" className="h-9 w-[140px] rounded-lg"><SelectValue placeholder="platform" /></SelectTrigger>
            <SelectContent>
              {PLATFORMS.map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="studio-sim-country" className="sr-only">Simulated country</Label>
          <Select value={sim.country || undefined} onValueChange={(v) => setSim((s) => ({ ...s, country: v }))}>
            <SelectTrigger id="studio-sim-country" className="h-9 w-[190px] rounded-lg">
              <SelectValue placeholder="country" />
            </SelectTrigger>
            <SelectContent>
              {COUNTRIES.map((c) => (
                <SelectItem key={c.code} value={c.code}>
                  {c.name} · {c.code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-[200px] flex-1 space-y-1">
          <Label htmlFor="studio-sim-claims" className="sr-only">Simulated claims, comma-separated</Label>
          <Input id="studio-sim-claims" placeholder="claims, comma-separated" value={sim.claims} onChange={(e) => setSim((s) => ({ ...s, claims: e.target.value }))} className="h-9 w-full rounded-lg" />
        </div>
        <Button size="sm" variant="outline" onClick={() => void runSimulation()} disabled={busy} aria-busy={busy} className="rounded-lg">
          {busy ? "Simulating…" : "Simulate"}
        </Button>
      </div>
      {simError && (
        <p role="alert" className="mt-2 break-words text-[12px] text-rose-600 dark:text-rose-300">{simError}</p>
      )}
      <AnimatePresence>
        {simResult && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className={cn("mt-3 rounded-lg p-3 text-[12.5px] leading-relaxed ring-1", simResult.decision === "allow" ? "bg-emerald-50 text-emerald-900 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900" : "bg-rose-50 text-rose-900 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900")}>
              <p className="font-semibold">Simulated: {simResult.decision === "allow" ? "would be allowed" : "would be blocked"}</p>
              {simResult.decision === "allow" ? (
                <p className="mt-0.5">Verified claims: {simResult.allowedClaims.join("; ") || "none"} · {simResult.plan.length} production stages</p>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {simResult.blockers.map((b, i) => <li key={i}>· {b.message}</li>)}
                </ul>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <button onClick={() => setShowSparql((v) => !v)} className="mt-3 inline-flex items-center gap-1 text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
        <ChevronDown className={cn("h-3.5 w-3.5 transition", showSparql && "rotate-180")} />
        {showSparql ? "Hide" : "Show"} the proof queries behind this decision
      </button>
      {showSparql && (
        <pre className="mt-2 overflow-x-auto rounded-xl bg-[#101614] p-4 font-mono text-[11px] leading-relaxed text-emerald-200/90">
          {sparqlPreview}
        </pre>
      )}
    </div>
  );
}
