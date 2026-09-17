"use client";

import { useState } from "react";
import { Check, CircleDashed, Loader2, RotateCcw, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiPost } from "@/lib/api";
import { useInvalidateWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import { cn } from "@/lib/utils";
import type { Campaign } from "@/server/types";
import { formatUsd, plainActivity } from "./studio-model";

interface QueuePanelProps {
  campaign: Campaign;
  allowed: boolean;
  onChanged: () => Promise<void>;
}

const STATUS_META: Record<string, { label: string; className: string }> = {
  queued: { label: "Queued", className: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800" },
  running: { label: "Running", className: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800" },
  succeeded: { label: "Done", className: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800" },
  failed: { label: "Failed", className: "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-800" }
};

/**
 * Right panel: the generation queue and per-output status. Retries re-queue
 * the failed stage through the produce endpoint; refinements regenerate one
 * stage with reviewer instructions. Both reuse the existing APIs — the panel
 * only ever displays real job records.
 */
export function QueuePanel({ campaign, allowed, onChanged }: QueuePanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refineFor, setRefineFor] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();

  const done = campaign.jobs.filter((j) => j.status === "succeeded").length;
  const total = campaign.jobs.length;
  const failed = campaign.jobs.filter((j) => j.status === "failed");

  async function retryFailed() {
    if (busy || failed.length === 0) return;
    setBusy("retry");
    setError(null);
    try {
      await apiPost(`/api/campaigns/${campaign.id}/produce`, { stageIds: failed.map((j) => j.stageId) });
      invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retry failed to start.");
    } finally {
      setBusy(null);
    }
  }

  async function refine(jobId: string, stageId: string) {
    if (busy || !instructions.trim()) return;
    setBusy(`refine-${jobId}`);
    setError(null);
    try {
      await apiPost(`/api/campaigns/${campaign.id}/revise`, { stageId, instructions: instructions.trim() });
      setRefineFor(null);
      setInstructions("");
      invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refinement failed to start. Your instructions are preserved.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label="Generation queue" className="flex h-full flex-col rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold tracking-tight">Queue</h3>
        {total > 0 && (
          <span className="font-mono text-[11px] text-muted-foreground" role="status">
            {done}/{total} stages complete
          </span>
        )}
      </div>

      {total === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-border p-4 text-center">
          <p className="text-[13px] font-medium">Queue is empty</p>
          <p className="mx-auto mt-1 max-w-[220px] text-[12px] leading-relaxed text-muted-foreground">
            Select deliverables in the creative plan and generate — queued stages appear here with live status.
          </p>
        </div>
      ) : (
        <ul className="mt-4 space-y-2.5">
          {campaign.jobs.map((job) => {
            const stage = campaign.preflight?.plan.find((s) => s.id === job.stageId);
            const meta = STATUS_META[job.status] ?? STATUS_META.queued;
            const refining = refineFor === job.id;
            return (
              <li key={job.id} className="rounded-xl bg-muted/50 p-3 ring-1 ring-border">
                <div className="flex items-center gap-2">
                  {job.status === "running" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-600" aria-hidden />}
                  {job.status === "queued" && <CircleDashed className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />}
                  {job.status === "succeeded" && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />}
                  {job.status === "failed" && <X className="h-3.5 w-3.5 shrink-0 text-rose-600 dark:text-rose-300" aria-hidden />}
                  <p className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{stage?.label ?? job.stageId}</p>
                  <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1", meta.className)}>
                    {meta.label}
                  </span>
                </div>
                <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={job.capability}>
                  {job.capability}
                  {typeof job.costUsd === "number" && ` · ${formatUsd(job.costUsd)}`}
                </p>
                {(job.status === "queued" || job.status === "running") && (
                  <p className="mt-1 animate-pulse text-[12px] font-medium text-amber-700 dark:text-amber-300" role="status">
                    {plainActivity(job.stageId, stage?.label ?? job.stageId, job.status)}
                  </p>
                )}
                {job.outputUrl && job.status === "succeeded" && (
                  job.kind === "image-to-video" ? (
                    <video src={job.outputUrl} controls preload="metadata" className="mt-2 aspect-video w-full rounded-lg bg-black object-contain" />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={job.outputUrl} alt={stage?.label ?? "generated output"} loading="lazy" className="mt-2 aspect-video w-full rounded-lg object-cover ring-1 ring-border" />
                  )
                )}
                {job.error && (
                  <p className="mt-1.5 break-words text-[11.5px] text-rose-600 dark:text-rose-300">{job.error}</p>
                )}
                {job.humanSummary && (
                  <p className="mt-1 text-[11.5px] italic text-muted-foreground">{job.humanSummary}</p>
                )}
                <button
                  type="button"
                  onClick={() => setDetailsFor(detailsFor === job.id ? null : job.id)}
                  aria-expanded={detailsFor === job.id}
                  aria-controls={`prod-details-${job.id}`}
                  className="mt-1.5 text-[11.5px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {detailsFor === job.id ? "Hide technical details" : "Technical details for verification"}
                </button>
                {detailsFor === job.id && (
                  <dl id={`prod-details-${job.id}`} className="mt-1.5 space-y-1 rounded-lg bg-background/60 p-2.5 font-mono text-[10.5px] ring-1 ring-border">
                    <div className="flex justify-between gap-2">
                      <dt className="shrink-0 text-muted-foreground">capability</dt>
                      <dd className="min-w-0 break-all text-right" title={job.capability}>{job.capability}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="shrink-0 text-muted-foreground">provider job</dt>
                      <dd className="min-w-0 truncate text-right" title={job.livepeerJobId ?? "not reported yet"}>{job.livepeerJobId ?? "not reported yet"}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="shrink-0 text-muted-foreground">request</dt>
                      <dd className="min-w-0 text-right">
                        {[job.requestMeta?.aspectRatio, job.requestMeta?.durationSeconds ? `${job.requestMeta.durationSeconds}s` : null, job.requestMeta?.sourceKind === "prior-output" ? "prior stage output" : job.requestMeta?.sourceKind === "source-media" ? "source media" : null].filter(Boolean).join(" · ") || "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="shrink-0 text-muted-foreground">status</dt>
                      <dd className="min-w-0 text-right">{job.status}{job.startedAt ? ` · started ${new Date(job.startedAt).toLocaleTimeString()}` : ""}{job.finishedAt ? ` · ended ${new Date(job.finishedAt).toLocaleTimeString()}` : ""}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="shrink-0 text-muted-foreground">cost</dt>
                      <dd className="min-w-0 text-right">{typeof job.costUsd === "number" ? formatUsd(job.costUsd) : "not billed yet"}</dd>
                    </div>
                    {job.outputUrl && (
                      <div className="flex justify-between gap-2">
                        <dt className="shrink-0 text-muted-foreground">output</dt>
                        <dd className="min-w-0 truncate text-right">
                          <a href={job.outputUrl} target="_blank" rel="noreferrer" className="text-sky-700 hover:underline dark:text-sky-300">open output URL</a>
                        </dd>
                      </div>
                    )}
                  </dl>
                )}
                {job.status === "succeeded" && (
                  <div className="mt-2">
                    {refining ? (
                      <div className="space-y-1.5">
                        <Label htmlFor={`refine-${job.id}`} className="sr-only">Refinement instructions for {stage?.label ?? job.stageId}</Label>
                        <Input
                          id={`refine-${job.id}`}
                          value={instructions}
                          onChange={(e) => setInstructions(e.target.value)}
                          placeholder="e.g. warmer light, more space above the shoe"
                          className="h-8 rounded-lg text-[12px]"
                        />
                        <div className="flex gap-1.5">
                          <Button
                            size="sm"
                            onClick={() => void refine(job.id, job.stageId)}
                            disabled={!instructions.trim() || busy !== null}
                            aria-busy={busy === `refine-${job.id}`}
                            className="h-7 rounded-full bg-violet-600 px-3 text-[11.5px] font-medium text-white hover:bg-violet-500"
                          >
                            {busy === `refine-${job.id}` ? "Starting…" : "Regenerate"}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => { setRefineFor(null); setInstructions(""); }} disabled={busy !== null} className="h-7 rounded-full px-2.5 text-[11.5px]">
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => { setRefineFor(job.id); setInstructions(""); }} disabled={busy !== null} className="h-7 rounded-full px-2.5 text-[11.5px] text-muted-foreground hover:text-foreground">
                        <Wand2 className="h-3 w-3" aria-hidden /> Refine
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {error && <p role="alert" className="mt-3 break-words text-[12px] text-rose-600 dark:text-rose-300">{error}</p>}

      {failed.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void retryFailed()}
          disabled={!allowed || busy !== null}
          aria-busy={busy === "retry"}
          title={!allowed ? "Generation is locked until the permission check passes" : undefined}
          className="mt-3 w-full rounded-full"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          {busy === "retry" ? "Re-queueing…" : `Retry ${failed.length} failed stage${failed.length === 1 ? "" : "s"}`}
        </Button>
      )}
    </section>
  );
}
