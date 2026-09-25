"use client";

import { useState } from "react";
import { Check, CircleDashed, Hourglass, Loader2, RotateCcw, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiPost } from "@/lib/api";
import { newRunKey } from "@/lib/idempotency-key";
import { useInvalidateWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import { useRunProgress } from "@/lib/use-run-progress";
import { cn } from "@/lib/utils";
import type { Campaign, ProductionJob, ProductionStagePlan } from "@/server/types";
import { deliveryBlockedJobIds, isActiveJobStatus } from "@/server/types";
import { deriveQualityReview } from "@/server/livepeer/quality-review";
import { formatUsd, plainActivity, displayCapability, queueStatusForJob } from "./studio-model";

interface QueuePanelProps {
  campaign: Campaign;
  allowed: boolean;
  onChanged: () => Promise<void>;
}

const STATUS_META: Record<string, { label: string; className: string }> = {
  queued: { label: "Queued", className: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800" },
  waiting: { label: "Waiting for dependency", className: "bg-muted text-muted-foreground ring-border" },
  generating: { label: "Generating", className: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800" },
  preview_ready: { label: "Checking quality", className: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-800" },
  storage_pending: { label: "Saving", className: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800" },
  storage_retry_needed: { label: "Retry needed", className: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800" },
  retrying: { label: "Retrying soon", className: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800" },
  ready_to_share: { label: "Ready", className: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800" },
  needs_review: { label: "Needs ratio review", className: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800" },
  failed: { label: "Failed", className: "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-800" },
  cancelled: { label: "Cancelled", className: "bg-muted text-muted-foreground ring-border" }
};

/** Display state: queued jobs blocked on an unready dependency wait instead. */
function displayStatus(
  job: ProductionJob,
  plan: ProductionStagePlan[] | undefined,
  readyStages: Set<string>
): string {
  // Backoff scheduled by the runner: the next pump dispatches once the
  // window passes (the claim clears it). No clock reads here - staleness
  // is bounded by the polling cadence, which always pumps on load.
  if ((job.status === "queued" || job.status === "generating") && job.nextAttemptAt) {
    return "retrying";
  }
  if (job.status === "queued") {
    const stage = plan?.find((s) => s.id === job.stageId);
    const deps = stage?.dependsOnStageIds ?? (stage?.kind === "image-to-video" ? ["keyframe"] : []);
    if (deps.some((d) => !readyStages.has(d))) return "waiting";
  }
  return job.status;
}

/**
 * Right panel: the generation queue and per-output status. Retries re-queue
 * the failed stage through the produce endpoint; refinements regenerate one
 * stage with reviewer instructions. Both reuse the existing APIs - the panel
 * only ever displays real job records.
 */
export function QueuePanel({ campaign, allowed, onChanged }: QueuePanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refineFor, setRefineFor] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const [cancelNote, setCancelNote] = useState<string | null>(null);
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();

  const total = campaign.jobs.length;
  const failed = campaign.jobs.filter((j) => j.status === "failed");
  // Delivery-blocked outputs (ratio mismatch) stay stored and reviewable
  // but never count as Ready/Complete: the job status is untouched
  // (generation settled), only the display derivation changes. Dependency
  // gating still uses the stored output, so readyStages is unchanged.
  const blockedJobIds = deliveryBlockedJobIds(campaign.receipts);
  const done = campaign.jobs.filter((j) => j.status === "ready_to_share" && !blockedJobIds.has(j.id)).length;
  // Advisory critique attention: subtle marker only, never a status change.
  const attentionJobIds = new Set(
    campaign.jobs
      .filter((j) => deriveQualityReview(j, campaign.receipts.find((r) => r.jobId === j.id)).state === "needs_attention")
      .map((j) => j.id)
  );
  const readyStages = new Set(
    campaign.jobs.filter((j) => j.status === "ready_to_share").map((j) => j.stageId)
  );
  const plan = campaign.preflight?.plan;
  const activeRun = [...(campaign.runs ?? [])].reverse().find((r) => r.status === "active") ?? null;
  const lastRun = [...(campaign.runs ?? [])].reverse()[0] ?? null;
  // Progressive follow: while a run is active the run endpoint is polled
  // with backoff (stops on terminal, cleans up on unmount); completed
  // assets appear as each job row refreshes. Leave and return anytime -
  // the run record resumes from durable state.
  const runStatus = useRunProgress(campaign.id, activeRun?.id ?? null, onChanged);
  const runReady = runStatus?.progress.ready ?? campaign.jobs.filter((j) => j.status === "ready_to_share" && !blockedJobIds.has(j.id) && (activeRun ? activeRun.stageIds.includes(j.stageId) : true)).length;
  const runTotal = runStatus?.progress.total ?? activeRun?.stageIds.length ?? total;
  const spent = campaign.jobs.filter((j) => j.status === "ready_to_share").reduce((s, j) => s + (j.costUsd ?? 0), 0);

  async function retryFailed() {
    if (busy || failed.length === 0) return;
    setBusy("retry");
    setError(null);
    try {
      await apiPost(`/api/campaigns/${campaign.id}/produce`, {
        stageIds: failed.map((j) => j.stageId),
        idempotencyKey: newRunKey("retry")
      });
      invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retry failed to start.");
    } finally {
      setBusy(null);
    }
  }

  async function cancelJob(jobId: string) {
    if (busy) return;
    setBusy(`cancel-${jobId}`);
    setError(null);
    setCancelNote(null);
    try {
      const result = await apiPost<{ ok: boolean; results: { jobId: string; outcome: string; detail: string }[] }>(
        `/api/campaigns/${campaign.id}/cancel`,
        { jobIds: [jobId] }
      );
      const first = result.results[0];
      setCancelNote(first ? `${first.outcome}: ${first.detail}` : "Cancel requested.");
      invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cancel failed.");
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
    <section aria-label="Generation queue" className="flex min-w-0 flex-col rounded-2xl border border-border bg-card p-4 xl:h-full xl:min-h-0 xl:overflow-hidden">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold tracking-tight">Queue</h3>
        {total > 0 && (
          <span className="font-mono text-[11px] text-muted-foreground" role="status">
            {activeRun ? `${runReady} of ${runTotal} ready` : `${done}/${total} stages complete`}
            {attentionJobIds.size > 0 ? ` · ${attentionJobIds.size} need${attentionJobIds.size === 1 ? "s" : ""} attention` : ""}
          </span>
        )}
      </div>
      {(activeRun || lastRun) && (
        <p className="mt-1.5 break-words text-[11.5px] text-muted-foreground" role="status">
          Run {activeRun ? "active" : "finished"}
          {runStatus?.estimateTotal !== null && runStatus?.estimateTotal !== undefined && ` · pack est. ${formatUsd(runStatus.estimateTotal)}`}
          {` · spent ${formatUsd(runStatus?.actualTotal ?? spent)}`}
          {(runStatus?.spendCapUsd ?? lastRun?.spendCapUsd) !== undefined && ` of ${formatUsd((runStatus?.spendCapUsd ?? lastRun?.spendCapUsd) as number)} cap`}
          {runStatus?.run?.note && ` · ${runStatus.run.note}`}
        </p>
      )}

      {total === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-border p-4 text-center">
          <p className="text-[13px] font-medium">Queue is empty</p>
          <p className="mx-auto mt-1 max-w-[220px] text-[12px] leading-relaxed text-muted-foreground">
            Select deliverables in the creative plan and generate - queued stages appear here with live status.
          </p>
        </div>
      ) : (
        <ul className="pf-pane-scroll mt-3 space-y-2 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1">
          {campaign.jobs.map((job) => {
            const stage = campaign.preflight?.plan.find((s) => s.id === job.stageId);
            const blocked = blockedJobIds.has(job.id);
            const shown = queueStatusForJob(displayStatus(job, plan, readyStages), blocked);
            const meta = STATUS_META[shown] ?? STATUS_META.queued;
            const refining = refineFor === job.id;
            // A rejected submit has no provider id even though its local
            // status was advanced to generating. It has never been billed
            // and can be cancelled locally before its retry window opens.
            const cancellable = (job.status === "queued" || job.status === "generating") && !job.livepeerJobId;
            return (
              <li
                key={job.id}
                className="min-w-0 rounded-xl bg-muted/50 p-3 ring-1 ring-border"
              >
                <div className="flex items-center gap-2">
                  {job.status === "generating" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-600" aria-hidden />}
                  {job.status === "queued" && shown === "waiting" && <Hourglass className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                  {job.status === "queued" && shown !== "waiting" && <CircleDashed className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />}
                  {job.status === "storage_pending" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-600" aria-hidden />}
                  {job.status === "ready_to_share" && !blocked && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />}
                  {job.status === "failed" && <X className="h-3.5 w-3.5 shrink-0 text-rose-600 dark:text-rose-300" aria-hidden />}
                  {job.status === "cancelled" && <X className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                  <p className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{stage?.label ?? job.stageId}</p>
                  <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1", meta.className)}>
                    {meta.label}
                  </span>
                  {attentionJobIds.has(job.id) && (
                    <span
                      className="shrink-0 text-[10px] font-medium text-amber-700 dark:text-amber-300"
                      title="The automated visual check flagged this output - see Review & deliver. Advisory only: nothing failed or blocked."
                    >
                      needs attention
                    </span>
                  )}
                  {cancellable && allowed && (
                    <button
                      type="button"
                      onClick={() => void cancelJob(job.id)}
                      disabled={busy !== null}
                      title="Cancel before dispatch - nothing has been spent on this stage"
                      className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium text-muted-foreground underline-offset-2 ring-1 ring-border hover:text-foreground hover:underline"
                    >
                      {busy === `cancel-${job.id}` ? "Cancelling…" : "Cancel"}
                    </button>
                  )}
                </div>
                <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={displayCapability(job)}>
                  {displayCapability(job)}
                  {typeof job.costUsd === "number" && ` · ${formatUsd(job.costUsd)}`}
                </p>
                {isActiveJobStatus(job.status) && (
                  <p className="mt-1 animate-pulse text-[12px] font-medium text-amber-700 dark:text-amber-300" role="status">
                    {plainActivity(job.stageId, stage?.label ?? job.stageId, job.status)}
                  </p>
                )}
                {job.outputUrl && (job.status === "ready_to_share" || job.status === "preview_ready" || job.status === "storage_pending" || job.status === "storage_retry_needed") && (
                  <div className="mt-2 h-40 overflow-hidden rounded-lg bg-black/40 ring-1 ring-border sm:h-44">
                    {job.kind === "image-to-video" ? (
                      <video src={job.outputUrl} controls preload="metadata" className="h-full w-full object-cover" />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={job.outputUrl} alt={stage?.label ?? "generated output"} loading="lazy" className="h-full w-full object-cover" />
                    )}
                  </div>
                )}
                {job.status === "preview_ready" && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">Output received - checking quality and saving securely. Not share-ready yet.</p>
                )}
                {job.status === "storage_pending" && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">Saving securely. Not share-ready yet.</p>
                )}
                {shown === "retrying" && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground" role="status">
                    Submit hiccup - retrying automatically{job.lastTransientError ? `: ${job.lastTransientError}` : "."} Nothing extra is spent: retries reuse the same provider key.
                  </p>
                )}
                {job.status === "storage_retry_needed" && (
                  <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                    Preview kept - secure storage needs a retry. Use “Retry secure storage” in Review &amp; deliver.
                  </p>
                )}
                {blocked && job.status === "ready_to_share" && (
                  <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-300" role="status">
                    Stored and reviewable below - not deliverable to clients until the ratio matches the planned placement. Generation succeeded; nothing was deleted.
                  </p>
                )}
                {job.error && (
                  <p className="mt-1.5 break-words text-[11.5px] text-rose-600 dark:text-rose-300">{job.error}</p>
                )}
                {job.humanSummary && (
                  <p className="mt-1 break-words text-[11.5px] italic text-muted-foreground">{job.humanSummary}</p>
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
                      <dd className="min-w-0 break-all text-right" title={displayCapability(job)}>{displayCapability(job)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="shrink-0 text-muted-foreground">provider job</dt>
                      <dd className="min-w-0 truncate text-right" title={job.livepeerJobId ?? "not reported yet"}>{job.livepeerJobId ?? "not reported yet"}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="shrink-0 text-muted-foreground">request</dt>
                      <dd className="min-w-0 text-right" title={job.requestMeta?.durationNote ?? undefined}>
                        {[job.requestMeta?.aspectRatio, job.requestMeta?.durationSeconds ? `${job.requestMeta.durationSeconds}s${job.requestMeta?.requestedDurationSeconds !== undefined && job.requestMeta.requestedDurationSeconds !== job.requestMeta.durationSeconds ? ` (requested ${job.requestMeta.requestedDurationSeconds}s)` : ""}` : null, job.requestMeta?.sourceKind === "prior-output" ? "prior stage output" : job.requestMeta?.sourceKind === "source-media" ? "source media" : null].filter(Boolean).join(" · ") || "-"}
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
                    {(() => {
                      // Preservation provenance: what preservation path this
                      // job took (requested → resolved tool + claimable level).
                      // Detail lives in Review once the output lands.
                      const m = job.requestMeta;
                      if (!m?.preservationResolved) return null;
                      const bits = [
                        m.preservationRequested && m.preservationRequested !== m.preservationResolved
                          ? `${m.preservationRequested} → ${m.preservationResolved}`
                          : m.preservationResolved,
                        m.preservationActualCapability ? `via ${m.preservationActualCapability}` : null,
                        m.preservationEvidenceLevel && m.preservationEvidenceLevel !== "none"
                          ? m.preservationEvidenceLevel
                          : "no preservation claim"
                      ].filter(Boolean).join(" · ");
                      return (
                        <div className="flex justify-between gap-2">
                          <dt className="shrink-0 text-muted-foreground">preservation</dt>
                          <dd className="min-w-0 break-words text-right" title={m.fallbackReason ?? bits}>{bits}</dd>
                        </div>
                      );
                    })()}
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
                {job.status === "ready_to_share" && (
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
      {cancelNote && <p role="status" className="mt-3 break-words text-[12px] text-muted-foreground">{cancelNote}</p>}

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
