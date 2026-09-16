"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleDot,
  Download,
  Gauge,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FadeIn, VerdictCheck, VerdictCross } from "@/components/motion-primitives";
import { CampaignExtras } from "@/components/campaign-extras";
import { StatusBadge } from "@/components/ui/status-badge";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { apiGet, apiPost } from "@/lib/api";
import { useInvalidateDkgGraph } from "@/lib/use-dkg-graph";
import { useInvalidateWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import type { Campaign, PermissionPassport, ProductFacts, SourceMedia } from "@/server/types";
import { cn } from "@/lib/utils";

interface CampaignResponse {
  campaign: Campaign;
  sourceMedia: SourceMedia | null;
  passport: PermissionPassport | null;
  productFacts: ProductFacts | null;
}

const jobDot: Record<string, string> = {
  queued: "border-muted-foreground/30 text-muted-foreground",
  running: "border-amber-500 text-amber-600 animate-pulse",
  succeeded: "border-emerald-600 bg-emerald-600 text-white",
  failed: "border-rose-500 bg-rose-500 text-white"
};

const PLATFORMS = ["instagram", "tiktok", "youtube", "linkedin"];

export default function CampaignWorkspacePage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [data, setData] = useState<CampaignResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviseFor, setReviseFor] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [showSparql, setShowSparql] = useState(false);
  const [sim, setSim] = useState({ platform: "", country: "", claims: "" });
  const [simResult, setSimResult] = useState<{ decision: string; blockers: { code: string; message: string }[]; allowedClaims: string[]; plan: unknown[] } | null>(null);
  const [simError, setSimError] = useState<string | null>(null);

  const [lastAction, setLastAction] = useState<{ label: string; path: string; body?: unknown } | null>(null);
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();
  const invalidateDkgGraph = useInvalidateDkgGraph();

  function requestCampaign(signal?: AbortSignal) {
    return apiGet<CampaignResponse>(`/api/campaigns/${id}`, signal);
  }

  useEffect(() => {
    const controller = new AbortController();
    requestCampaign(controller.signal).then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Campaign failed to load.");
      }
    );
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function reloadCampaign() {
    try {
      setData(await requestCampaign());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Campaign failed to load.");
    }
  }

  const active = useMemo(
    () => data?.campaign.jobs.some((j) => j.status === "queued" || j.status === "running") ?? false,
    [data]
  );

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void reloadCampaign(), 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function action(label: string, path: string, body?: unknown) {
    if (busy) return;
    setBusy(label);
    setLastAction({ label, path, body });
    setError(null);
    try {
      await apiPost(`/api/campaigns/${id}${path}`, body);
      // Policy simulation is what-if only and never changes the campaign;
      // every other action changes visible workspace data. Approval also
      // publishes the campaign record to the DKG.
      if (path !== "/simulate") invalidateSnapshot();
      if (path === "/approve") invalidateDkgGraph();
      await reloadCampaign();
    } catch (e) {
      // Campaign state is untouched; the buttons below retry the same action.
      setError(e instanceof Error ? e.message : `${label} failed.`);
    } finally {
      setBusy(null);
    }
  }

  async function runSimulation() {
    if (busy) return;
    setSimResult(null);
    setSimError(null);
    setBusy("simulate");
    try {
      const j = await apiPost<{ decision: { decision: string; blockers: { code: string; message: string }[]; allowedClaims: string[]; plan: unknown[] } }>(
        `/api/campaigns/${id}/simulate`,
        {
          platform: sim.platform || undefined,
          country: sim.country || undefined,
          requestedClaims: sim.claims ? sim.claims.split(",").map((c) => c.trim()).filter(Boolean) : undefined
        }
      );
      setSimResult(j.decision);
    } catch (e) {
      // Simulator inputs are preserved for retry.
      setSimError(e instanceof Error ? e.message : "Simulation failed. Your inputs are preserved.");
    } finally {
      setBusy(null);
    }
  }

  if (error && !data) {
    return <div className="pf-page"><ErrorState message={error} onRetry={reloadCampaign} /></div>;
  }
  if (!data) return <div className="pf-page"><LoadingSkeleton rows={3} /></div>;

  const { campaign, sourceMedia, passport, productFacts } = data;
  const decision = campaign.preflight;
  const allowed = decision?.decision === "allow";

  return (
    <div className="pf-page space-y-7">
      {/* Header */}
      <FadeIn>
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0 max-w-2xl">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display text-balance text-3xl font-semibold tracking-tight">{campaign.title}</h1>
              <StatusBadge status={campaign.status} />
            </div>
            <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              {campaign.brand} {campaign.productName} · {campaign.request.platform} · {campaign.request.country} · {campaign.request.transformation} pack
            </p>
            <p className="mt-3 text-[14px] italic leading-relaxed text-muted-foreground">“{campaign.request.creativeBrief}”</p>
          </div>
          {sourceMedia && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={sourceMedia.url} alt="source media" className="h-24 w-16 rounded-xl object-cover ring-1 ring-border" />
          )}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Chip label="claims requested" value={campaign.request.requestedClaims.join(", ") || "—"} />
          <Chip label="passport" value={passport?.id ?? "—"} mono />
          <Chip label="facts" value={productFacts?.id ?? "—"} mono />
        </div>
      </FadeIn>

      {/* Action errors: visible, retryable, dismissible — state is untouched */}
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2.5 rounded-xl bg-rose-50 px-4 py-3 text-[13px] text-rose-800 ring-1 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900"
        >
          <span className="min-w-0 flex-1 break-words">{error}</span>
          {lastAction && (
            <button
              type="button"
              onClick={() => action(lastAction.label, lastAction.path, lastAction.body)}
              disabled={busy !== null}
              className="shrink-0 rounded-full px-3 py-1 text-[12px] font-medium underline underline-offset-2 hover:no-underline disabled:opacity-50"
            >
              Retry{busy ? "…" : ""}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setError(null);
              setLastAction(null);
            }}
            className="shrink-0 rounded-full px-3 py-1 text-[12px] font-medium text-rose-700 underline underline-offset-2 hover:no-underline dark:text-rose-300"
          >
            Dismiss
          </button>
        </div>
      )}

      {!decision && (
        <FadeIn delay={0.05}>
          <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-6 dark:border-amber-900 dark:bg-amber-950/30">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-800 dark:text-amber-300">Policy check required</p>
            <h2 className="mt-2 text-[16px] font-semibold">Run the DKG preflight before production</h2>
            <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">This workspace loaded from Neon. Running this check now queries creator permissions and verified product facts in the DKG, then stores the decision for this campaign.</p>
            <Button
              size="sm"
              onClick={() => action("repreflight", "/repreflight")}
              disabled={busy !== null}
              aria-busy={busy === "repreflight"}
              className="mt-4 rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", busy === "repreflight" && "animate-spin")} aria-hidden /> {busy === "repreflight" ? "Checking policy…" : "Run DKG preflight"}
            </Button>
          </section>
        </FadeIn>
      )}

      {/* Verdict */}
      {decision && (
        <FadeIn delay={0.05}>
          <div
            id="evidence"
            className={cn(
              "scroll-mt-24 overflow-hidden rounded-2xl border",
              allowed ? "border-emerald-200 bg-gradient-to-b from-emerald-50/80 to-card dark:border-emerald-900 dark:from-emerald-950/40" : "border-rose-200 bg-gradient-to-b from-rose-50/80 to-card dark:border-rose-900 dark:from-rose-950/40"
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-inherit px-6 py-4">
              <div className="flex items-center gap-3">
                <span className={cn("grid h-9 w-9 place-items-center rounded-full", allowed ? "bg-emerald-600 text-emerald-50" : "bg-rose-600 text-rose-50")}>
                  {allowed ? <VerdictCheck className="h-4.5 w-4.5" /> : <VerdictCross className="h-4 w-4" />}
                </span>
                <div>
                  <p className={cn("text-[15px] font-semibold", allowed ? "text-emerald-900 dark:text-emerald-200" : "text-rose-900 dark:text-rose-200")}>
                    {allowed ? "Production permitted" : "Generation blocked"}
                  </p>
                  <p className={cn("font-mono text-[10px] uppercase tracking-[0.14em]", allowed ? "text-emerald-700 dark:text-emerald-300/70" : "text-rose-700 dark:text-rose-300/70")}>
                    {decision.blockers.length > 0
                      ? `${decision.blockers.length} precise reason${decision.blockers.length > 1 ? "s" : ""} — no inference spent`
                      : "SPARQL preflight passed against the DKG"}
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => action("repreflight", "/repreflight")}
                  disabled={busy !== null}
                  aria-busy={busy === "repreflight"}
                  className="rounded-full"
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", busy === "repreflight" && "animate-spin")} aria-hidden /> {busy === "repreflight" ? "Checking…" : "Re-check policy"}
                </Button>
                {allowed && campaign.status !== "approved" && (
                  <Button
                    size="sm"
                    onClick={() => action("produce", "/produce")}
                    disabled={busy !== null || active}
                    aria-busy={busy === "produce" || active}
                    title={active ? "Production is running — this resumes automatically" : "Generate the keyframe, variations and video through Livepeer"}
                    className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
                  >
                    {busy === "produce" ? "Starting…" : active ? "Producing…" : <><Sparkles className="h-3.5 w-3.5" aria-hidden /> Produce campaign pack</>}
                  </Button>
                )}
                {campaign.status === "approved" && (
                  <Badge variant="outline" className="rounded-full bg-emerald-50 font-medium text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800">
                    <Check className="h-3 w-3" aria-hidden /> approved & published
                  </Badge>
                )}
              </div>
            </div>

            <div className="px-6 py-5">
              {decision.blockers.length > 0 ? (
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
                          {b.code} · evidence: {b.evidenceRefs.join(", ") || "graph query returned nothing"}
                        </p>
                      </div>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-xl bg-emerald-100/50 p-4 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:ring-emerald-900">
                    <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-800/80 dark:text-emerald-300/80">Why this was allowed</p>
                    <ul className="mt-2.5 space-y-2 text-[13px] leading-relaxed text-emerald-950/85 dark:text-emerald-100/90">
                      {decision.queriedRights.length > 0 && (
                        <li className="flex min-w-0 gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden />
                          <span className="min-w-0 break-all">Passport {decision.queriedRights[0]} — {passport?.platforms.join(", ")} · {passport?.countries.join(", ")} · valid to {passport?.validUntil} · {passport?.allowedTransformations.join(", ")}
                          </span>
                        </li>
                      )}
                      {decision.allowedClaims.length > 0 && (
                        <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden />Verified claims: {decision.allowedClaims.join("; ")}</li>
                      )}
                      {decision.queriedFacts.length > 0 && (
                        <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-300" />Facts asset {decision.queriedFacts[0]}</li>
                      )}
                    </ul>
                  </div>
                  <div className="rounded-xl bg-card p-4 ring-1 ring-border">
                    <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Constraints compiled into every prompt</p>
                    <ul className="mt-2.5 list-disc space-y-1.5 pl-4 text-[12.5px] leading-relaxed text-muted-foreground">
                      {decision.promptConstraints.map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                  </div>
                </div>
              )}

              {/* Simulator */}
              <div id="simulate" className="mt-4 scroll-mt-24 rounded-xl border border-dashed border-border p-4">
                <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  <Gauge className="h-3.5 w-3.5" /> Policy simulator — what-if only, never changes this campaign
                </p>
                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="sim-platform" className="sr-only">Simulated platform</Label>
                    <Select value={sim.platform} onValueChange={(v) => setSim((s) => ({ ...s, platform: v }))}>
                      <SelectTrigger id="sim-platform" className="h-9 w-[140px] rounded-lg"><SelectValue placeholder="platform" /></SelectTrigger>
                      <SelectContent>
                        {PLATFORMS.map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="sim-country" className="sr-only">Simulated country code</Label>
                    <Input id="sim-country" placeholder="country (DE)" maxLength={2} value={sim.country} onChange={(e) => setSim((s) => ({ ...s, country: e.target.value.toUpperCase() }))} className="h-9 w-[110px] rounded-lg" />
                  </div>
                  <div className="min-w-[200px] flex-1 space-y-1">
                    <Label htmlFor="sim-claims" className="sr-only">Simulated claims, comma-separated</Label>
                    <Input id="sim-claims" placeholder="claims, comma-separated" value={sim.claims} onChange={(e) => setSim((s) => ({ ...s, claims: e.target.value }))} className="h-9 w-full rounded-lg" />
                  </div>
                  <Button size="sm" variant="outline" onClick={runSimulation} disabled={busy !== null} aria-busy={busy === "simulate"} className="rounded-lg">
                    {busy === "simulate" ? "Simulating…" : "Simulate"}
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
              </div>

              <button onClick={() => setShowSparql((v) => !v)} className="mt-3 inline-flex items-center gap-1 text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                <ChevronDown className={cn("h-3.5 w-3.5 transition", showSparql && "rotate-180")} />
                {showSparql ? "Hide" : "Show"} the SPARQL queries the agent ran
              </button>
              {showSparql && (
                <pre className="mt-2 overflow-x-auto rounded-xl bg-[#101614] p-4 font-mono text-[11px] leading-relaxed text-emerald-200/90">
                  {decision.sparqlPreview}
                </pre>
              )}
            </div>
          </div>
        </FadeIn>
      )}

      {/* Pipeline */}
      {campaign.jobs.length > 0 && (
        <FadeIn delay={0.05}>
          <section className="rounded-2xl border border-border bg-card p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold tracking-tight">Production pipeline</h2>
              {active && <span className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-amber-600"><CircleDot className="h-3.5 w-3.5 animate-pulse" /> generating</span>}
            </div>
            <div className="mt-5 space-y-0">
              {campaign.jobs.map((job, idx) => {
                const stage = decision?.plan.find((s) => s.id === job.stageId);
                const isLast = idx === campaign.jobs.length - 1;
                return (
                  <div key={job.id} className="relative flex gap-4 pb-5 last:pb-0">
                    {!isLast && <span className="absolute left-[13px] top-8 h-full w-px bg-border" />}
                    <span className={cn("relative z-10 mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border-2 bg-card", jobDot[job.status] ?? jobDot.queued)}>
                      {job.status === "succeeded" ? <Check className="h-3.5 w-3.5" /> : job.status === "failed" ? <X className="h-3.5 w-3.5" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
                    </span>
                    <div className="min-w-0 flex-1 rounded-xl bg-muted/50 px-4 py-3 ring-1 ring-border">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-[13.5px] font-medium">{stage?.label ?? job.stageId}</p>
                          <p className="mt-0.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground">{job.capability}</p>
                        </div>
                        <div className="flex items-center gap-3">
                          {typeof job.costUsd === "number" && (
                            <span className="font-mono text-[11px] text-muted-foreground">${job.costUsd.toFixed(4)}</span>
                          )}
                          <span className={cn("text-[12px] font-medium capitalize",
                            job.status === "succeeded" && "text-emerald-700 dark:text-emerald-300",
                            job.status === "failed" && "text-rose-600 dark:text-rose-300",
                            job.status === "running" && "animate-pulse text-amber-600 dark:text-amber-300",
                            job.status === "queued" && "text-muted-foreground"
                          )}>
                            {job.status}
                          </span>
                          {job.status === "succeeded" && (
                            <Button variant="ghost" size="sm" onClick={() => { setReviseFor(reviseFor === job.id ? null : job.id); setInstructions(""); }} className="h-7 rounded-full px-2.5 text-[11.5px] text-muted-foreground hover:text-foreground">
                              Revise
                            </Button>
                          )}
                        </div>
                      </div>
                      {job.error && <p className="mt-2 break-words text-[12px] text-rose-600 dark:text-rose-300">{job.error}</p>}
                      {job.humanSummary && <p className="mt-1 text-[12px] italic text-muted-foreground">{job.humanSummary}</p>}
                      {reviseFor === job.id && (
                        <div className="mt-3 space-y-1.5">
                          <div className="flex gap-2">
                            <Label htmlFor={`revise-${job.id}`} className="sr-only">Reviewer instructions for {stage?.label ?? job.stageId}</Label>
                            <Input
                              id={`revise-${job.id}`}
                              value={instructions}
                              onChange={(e) => setInstructions(e.target.value)}
                              placeholder="e.g. warmer light, more space above the shoe"
                              aria-describedby={`revise-${job.id}-hint`}
                              className="h-9 rounded-lg"
                            />
                            <Button
                              size="sm"
                              onClick={() => { action(`revise-${job.id}`, "/revise", { stageId: job.stageId, instructions }); setReviseFor(null); }}
                              disabled={!instructions.trim() || busy !== null}
                              aria-busy={busy === `revise-${job.id}`}
                              title={!instructions.trim() ? "Describe the change to enable regeneration" : undefined}
                              className="h-9 shrink-0 rounded-lg bg-violet-600 font-medium text-white hover:bg-violet-500"
                            >
                              {busy === `revise-${job.id}` ? "Starting…" : "Regenerate"}
                            </Button>
                          </div>
                          <p id={`revise-${job.id}-hint`} className="text-[11px] text-muted-foreground">
                            Regenerate is disabled until you describe the change. Only this stage re-runs; the rest of the pack is kept.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </FadeIn>
      )}

      {/* Pack + receipts */}
      {campaign.receipts.length > 0 && (
        <FadeIn delay={0.05}>
          <section className="rounded-2xl border border-border bg-card p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-[15px] font-semibold tracking-tight">Campaign pack & derivative receipts</h2>
              <div className="flex gap-2">
                <Button asChild variant="outline" size="sm" className="rounded-full">
                  <a href={`/api/campaigns/${campaign.id}/bundle`} download><Download className="h-3.5 w-3.5" /> Proof bundle</a>
                </Button>
                {campaign.status !== "approved" && (
                  <Button
                    size="sm"
                    onClick={() => action("approve", "/approve")}
                    disabled={busy !== null || active || campaign.jobs.filter((j) => j.status === "succeeded").length === 0}
                    aria-busy={busy === "approve"}
                    title={campaign.jobs.filter((j) => j.status === "succeeded").length === 0 ? "Produce the pack first — there is nothing to approve yet" : active ? "Wait for production to finish before approving" : "Approve the pack and publish the campaign record"}
                    className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
                  >
                    {busy === "approve" ? "Publishing…" : "Approve & publish"}
                  </Button>
                )}
              </div>
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {campaign.receipts.map((r) => (
                <div key={r.id} className="group overflow-hidden rounded-xl bg-muted/60 ring-1 ring-border transition hover:ring-emerald-600/40">
                  {r.mediaType === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.outputUrl} alt={r.label} className="aspect-[3/4] w-full object-cover" />
                  ) : (
                    <video src={r.outputUrl} controls className="aspect-[3/4] w-full bg-black object-contain" />
                  )}
                  <div className="space-y-1 p-3">
                    <p className="text-[12.5px] font-medium leading-tight">{r.label}</p>
                    <p className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">{r.format} · {r.capability}</p>
                    {r.ual && <p className="truncate font-mono text-[10px] text-emerald-700 dark:text-emerald-300" title={r.ual}>{r.ual}</p>}
                    <Link href={`/verify/${r.id}`} className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-700 hover:underline dark:text-sky-300">
                      Verify <ArrowRight className="h-3 w-3" />
                    </Link>
                  </div>
                </div>
              ))}
            </div>
            {campaign.campaignUAL && (
              <p className="mt-4 min-w-0 break-all font-mono text-[11px] text-muted-foreground" title={campaign.campaignUAL}>
                Campaign record: <span className="text-emerald-700 dark:text-emerald-300">{campaign.campaignUAL}</span>
              </p>
            )}
          </section>
        </FadeIn>
      )}

      {campaign.status !== "blocked" && <CampaignExtras campaign={campaign} />}
    </div>
  );
}

function Chip({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-[11.5px] ring-1 ring-border">
      <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
      <span className={cn("pf-id text-foreground/80", mono && "font-mono text-[11px]")} title={value}>{value}</span>
    </span>
  );
}
