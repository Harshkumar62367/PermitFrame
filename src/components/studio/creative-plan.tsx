"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, CircleDashed, Loader2, Sparkles, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiGet, apiPost } from "@/lib/api";
import { newRunKey } from "@/lib/idempotency-key";
import { useInvalidateWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import { cn } from "@/lib/utils";
import { unsupportedCreativeFormatReason } from "@/lib/creative-format";
import type { Campaign, ProductionStagePlan } from "@/server/types";
import { deliveryBlockedJobIds } from "@/server/types";
import { deriveQualityReview } from "@/server/livepeer/quality-review";
import type { FilmMode } from "@/server/livepeer/film-plan";
import {
  deliverableKind,
  deliverableState,
  estimateStages,
  estimateStagesLive,
  formatUsd,
  hasUnknownPrice,
  planDeliverables,
  receiptsForStages,
  recommendInitialStages,
  type DeliverableState,
  type LivePriceEntry
} from "./studio-model";

interface CreativePlanProps {
  campaign: Campaign;
  allowed: boolean;
  /** Selected production mode - while Film mode is on, this control still generates the asset pack. */
  filmMode: FilmMode;
  onChanged: () => Promise<void>;
}
const STATE_META: Record<DeliverableState, { label: string; className: string }> = {
  ready: { label: "Not started", className: "bg-muted text-muted-foreground" },
  queued: { label: "Queued", className: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800" },
  running: { label: "Generating", className: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800" },
  partial: { label: "Partial", className: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800" },
  done: { label: "Complete", className: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800" },
  review: { label: "Needs ratio review", className: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800" },
  failed: { label: "Needs retry", className: "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-800" }
};

const UNAVAILABLE_META = {
  label: "Unavailable",
  className: "bg-muted text-muted-foreground ring-border"
};

/**
 * Main panel: the approved creative plan as selectable deliverables.
 * Selection is honest - only the selected plan stages are sent to the
 * produce endpoint, and stages that already succeeded stay done.
 */
function KindBadge({ stages }: { stages: ProductionStagePlan[] }) {
  const kind = deliverableKind(stages);
  const label = kind === "mixed" ? "Image + video" : kind === "video" ? "Video" : "Image";
  const tone =
    label === "Image"
      ? "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-800"
      : "bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-950/40 dark:text-violet-300 dark:ring-violet-800";
  return (
    <span
      className={cn("rounded-full px-2 py-0.5 text-[10.5px] font-medium ring-1", tone)}
      title={label === "Image" ? "Image generation" : "Includes video - slower and costlier than image"}
    >
      {label}
    </span>
  );
}
export function CreativePlan({ campaign, allowed, filmMode, onChanged }: CreativePlanProps) {
  const deliverables = useMemo(() => planDeliverables(campaign), [campaign]);
  const succeededStageIds = useMemo(
    () => new Set(campaign.jobs.filter((j) => j.status === "ready_to_share").map((j) => j.stageId)),
    [campaign]
  );
  // Stages whose stored output is delivery-blocked (ratio mismatch):
  // generated, reviewable, but never Complete - and not re-selectable
  // here (regeneration runs from Review & deliver).
  const blockedStageIds = useMemo(() => {
    const blockedJobs = deliveryBlockedJobIds(campaign.receipts);
    return new Set(
      campaign.jobs.filter((j) => blockedJobs.has(j.id)).map((j) => j.stageId)
    );
  }, [campaign]);
  const hasBlockedStages = blockedStageIds.size > 0;
  const [selected, setSelected] = useState<string[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();

  const unsupportedReasonByStageId = useMemo(
    () => new Map(deliverables.flatMap((d) => d.stages).map((stage) => [stage.id, unsupportedCreativeFormatReason(stage.capability, stage.format)])),
    [deliverables]
  );
  const selectable = deliverables
    .flatMap((d) => d.stages)
    .filter((s) => !succeededStageIds.has(s.id) && !unsupportedReasonByStageId.get(s.id));
  // Recommended start, not the whole pack: the platform-matched
  // deliverable's image stages (video is never preselected). Explicit user
  // choices override and persist; the recommendation only fills in while
  // nothing has been touched.
  const recommendedIds = useMemo(
    () => recommendInitialStages(campaign.request.platform, deliverables, succeededStageIds),
    [campaign.request.platform, deliverables, succeededStageIds]
  );
  const selectedIds = selected ?? recommendedIds;
  const selectedStages = selectable.filter((s) => selectedIds.includes(s.id));
  const estimate = estimateStages(selectedStages);
  const estimateExact = !hasUnknownPrice(selectedStages);
  const hasMotion = selectedStages.some((s) => s.kind === "image-to-video");
  const spent = campaign.jobs.filter((j) => j.status === "ready_to_share").reduce((s, j) => s + (j.costUsd ?? 0), 0);

  // Live Creative MCP prices load once, quietly, and never block the plan:
  // unreachable agent → historical estimates carry the "est." label as before.
  const [livePrices, setLivePrices] = useState<Record<string, LivePriceEntry> | null>(null);
  useEffect(() => {
    let active = true;
    apiGet<{ ok: boolean; prices?: { name: string; usd: number; unit: string }[] }>(
      "/api/livepeer/pricing",
      undefined,
      15000
    ).then(
      (d) => {
        if (!active || !d.ok || !d.prices) return;
        const map: Record<string, LivePriceEntry> = {};
        for (const p of d.prices) map[p.name] = { usd: p.usd, unit: p.unit };
        if (active) setLivePrices(map);
      },
      () => undefined // unreachable: historical estimates stand in
    );
    return () => {
      active = false;
    };
  }, []);
  const liveEstimate = estimateStagesLive(selectedStages, livePrices);
  const estimateLabel =
    liveEstimate && liveEstimate.exact
      ? `live ${formatUsd(liveEstimate.total)} selected`
      : livePrices
        ? "live pricing unavailable for this selection"
        : `est. ${formatUsd(estimate)}${estimateExact ? "" : "+"} selected`;

  function toggleStage(stageId: string) {
    setError(null);
    const base = selected ?? selectable.map((s) => s.id);
    setSelected(base.includes(stageId) ? base.filter((s) => s !== stageId) : [...base, stageId]);
  }

  function toggleDeliverable(stageIds: string[], checked: boolean) {
    setError(null);
    const base = new Set(selected ?? selectable.map((s) => s.id));
    for (const id of stageIds) {
      if (checked) base.add(id);
      else base.delete(id);
    }
    setSelected(selectable.filter((s) => base.has(s.id)).map((s) => s.id));
  }

  async function generate() {
    if (busy || selectedStages.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // Client-generated run key: double-clicks and retries replay the same
      // run instead of dispatching duplicate paid jobs.
      const submit = apiPost(`/api/campaigns/${campaign.id}/produce`, {
        stageIds: selectedStages.map((s) => s.id),
        idempotencyKey: newRunKey("studio")
      }, undefined, 90_000);
      // A cold server/database/ledger path can take longer than the provider
      // itself. Do not leave the confirmation dialog covering the page while
      // that durable, idempotent submit finishes. The request remains in
      // flight and `busy` stays true, so the user cannot accidentally create
      // a second paid run.
      const handoff = await Promise.race([
        submit.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000))
      ]);
      if (!handoff) {
        setConfirming(false);
        setError("Your request is being processed. Please stay on this page while it starts.");
        invalidateSnapshot();
        void onChanged();
      }
      await submit;
      setConfirming(false);
      setError(null);
      invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed to start. Nothing was spent.");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Creative plan" className="flex min-w-0 flex-col rounded-2xl border border-border bg-card p-4 xl:h-full xl:min-h-0 xl:overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[15px] font-semibold tracking-tight">Creative plan</h3>
          <p
            className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
            title={
              liveEstimate && liveEstimate.exact
                ? "Quoted from live Creative MCP prices"
                : livePrices
                  ? `Historical estimate ${formatUsd(estimate)}${estimateExact ? "" : "+"} - live prices do not cover this selection exactly`
                  : estimateExact
                    ? undefined
                    : "Some stages lack catalogue prices - actual spend may be higher"
            }
          >
            {estimateLabel} · {formatUsd(spent)} spent
          </p>
        </div>
        {selectable.length > 0 && (
          <div className="flex gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setSelected([])} className="h-7 rounded-full px-2.5 text-[11.5px]">
              Clear
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(selectable.map((s) => s.id))} className="h-7 rounded-full px-2.5 text-[11.5px]">
              Select all
            </Button>
          </div>
        )}
      </div>

      {selected === null && recommendedIds.length > 0 && (
        <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">
          Recommended start: {deliverables.find((d) => d.stages.some((s) => recommendedIds.includes(s.id)))?.title ?? "one deliverable"} -
          image stages only. Video is slower and costlier - select it deliberately, never by default.
        </p>
      )}
      {deliverables.length === 0 && (
        <p className="mt-4 text-[13px] text-muted-foreground">No approved plan stages - re-check rights to rebuild the plan.</p>
      )}

      <div className="pf-pane-scroll mt-3 space-y-2 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1">
        {deliverables.map((d) => {
          const stageIds = d.stages.map((s) => s.id);
          const state = deliverableState(campaign.jobs, stageIds, blockedStageIds);
          const unavailable = stageIds.length > 0 && stageIds.every((id) => !!unsupportedReasonByStageId.get(id));
          const meta = unavailable ? UNAVAILABLE_META : STATE_META[state];
          const selectableIds = stageIds.filter((id) => !succeededStageIds.has(id) && !unsupportedReasonByStageId.get(id));
          const checkedCount = selectableIds.filter((id) => selectedIds.includes(id)).length;
          const checked = selectableIds.length > 0 && checkedCount === selectableIds.length;
          const outputs = receiptsForStages(campaign.receipts, campaign.jobs, stageIds);
          return (
            <div
              key={d.id}
              className={cn(
                "rounded-xl border p-3 transition",
                selectableIds.length > 0 && checkedCount > 0 ? "border-emerald-600/40 bg-emerald-50/40 dark:border-emerald-800 dark:bg-emerald-950/20" : "border-border"
              )}
            >
              <div className="flex items-start gap-3">
                {selectableIds.length > 0 ? (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    aria-label={`Select ${d.title} (${d.spec}) for generation`}
                    onClick={() => toggleDeliverable(selectableIds, !checked)}
                    className={cn(
                      "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md ring-1 transition",
                      checked
                        ? "bg-emerald-600 text-white ring-emerald-600 dark:bg-emerald-500 dark:text-emerald-950"
                        : "bg-card text-transparent ring-border hover:ring-emerald-600/50"
                    )}
                  >
                    <Check className="h-3.5 w-3.5" aria-hidden />
                  </button>
                ) : unavailable ? (
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground ring-1 ring-border" aria-label={`${d.title} is unavailable`}>
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </span>
                ) : state === "review" ? (
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-amber-600/10 text-amber-700 ring-1 ring-amber-600/20 dark:text-amber-300" aria-label={`${d.title} needs ratio review`}>
                    <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
                  </span>
                ) : (
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-emerald-600/10 text-emerald-700 ring-1 ring-emerald-600/20 dark:text-emerald-300" aria-label={`${d.title} complete`}>
                    <Check className="h-3.5 w-3.5" aria-hidden />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{d.title}</p>
                    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium ring-1", meta.className)}>{meta.label}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[10px] text-secondary-foreground">{d.spec}</span>
                    <KindBadge stages={d.stages} />
                    {d.stages.some((s) => s.fidelity === "product-preserving") && (
                      <span className="rounded-full bg-emerald-600/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-600/20 dark:text-emerald-300" title="Identity preservation is required: place_subject with no generic fallback, plus a post-render identity check.">
                        Product-preserving
                      </span>
                    )}
                    {d.stages.some((s) => s.fidelity === "property-preserving") && (
                      <span className="rounded-full bg-emerald-600/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-600/20 dark:text-emerald-300" title="Identity preservation is required: place_subject with no generic fallback, plus a post-render identity check.">
                        Property-preserving
                      </span>
                    )}
                    <span className="font-mono text-[10px] text-muted-foreground">{formatUsd(estimateStages(d.stages.filter((s) => !succeededStageIds.has(s.id))))} remaining</span>
                  </div>
                  <p className="mt-1 text-[12px] text-muted-foreground">{d.platforms}</p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={`Planned capabilities: ${Array.from(new Set(d.stages.map((s) => s.capability))).join(", ")}`}>
                    via {Array.from(new Set(d.stages.map((s) => s.capability))).join(" + ")}
                  </p>
                  <ul className="mt-2 space-y-1">
                    {d.stages.map((stage) => {
                      const job = campaign.jobs.find((j) => j.stageId === stage.id);
                      const blocked = blockedStageIds.has(stage.id);
                      const done = job?.status === "ready_to_share" && !blocked;
                      const unsupportedReason = unsupportedReasonByStageId.get(stage.id);
                      const selectableStage = !done && !blocked && !unsupportedReason;
                      // Advisory attention only: never changes selectability.
                      const attention =
                        !!job &&
                        deriveQualityReview(job, campaign.receipts.find((r) => r.jobId === job.id)).state === "needs_attention";
                      const isChecked = selectedIds.includes(stage.id);
                      return (
                        <li key={stage.id} className="flex items-center gap-2 text-[12.5px]">
                          {selectableStage ? (
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={isChecked}
                              aria-label={`Select stage ${stage.label}`}
                              onClick={() => toggleStage(stage.id)}
                              className={cn(
                                "grid h-4 w-4 shrink-0 place-items-center rounded ring-1 transition",
                                isChecked ? "bg-emerald-600 text-white ring-emerald-600 dark:bg-emerald-500 dark:text-emerald-950" : "bg-card text-transparent ring-border hover:ring-emerald-600/50"
                              )}
                            >
                              <Check className="h-3 w-3" aria-hidden />
                            </button>
                          ) : unsupportedReason ? (
                            <span
                              className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border"
                              title={unsupportedReason}
                            >
                              Unavailable
                            </span>
                          ) : blocked ? (
                            <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800" title="Stored and reviewable, but not deliverable until the ratio matches - regenerate from Review & deliver">
                              Needs ratio review
                            </span>
                          ) : (
                            <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                          )}
                          <span className={cn("min-w-0 flex-1 truncate", !isChecked && selectableStage && "text-muted-foreground")}>
                            {stage.label}
                          </span>
                          {unsupportedReason && <span className="sr-only">{unsupportedReason}</span>}
                          {job && job.status === "generating" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-600" aria-hidden />}
                          {job && job.status === "queued" && <CircleDashed className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />}
                          {job && job.status === "failed" && <X className="h-3.5 w-3.5 shrink-0 text-rose-600" aria-hidden />}
                          {attention && (
                            <span
                              className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400"
                              title="The automated visual check flagged this output - see Review & deliver. Advisory only."
                              aria-label={`${stage.label} flagged for attention`}
                            />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {outputs.length > 0 || d.stages.length > 0 ? (
                    <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5">
                      {d.stages.map((stage) => {
                        const output = outputs.find((r) => {
                          const jobForStage = campaign.jobs.find((j) => j.stageId === stage.id);
                          return jobForStage && r.jobId === jobForStage.id;
                        });
                        if (!output) {
                          return (
                            <span key={stage.id} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-dashed border-border font-mono text-[9px] text-muted-foreground" title={`${stage.label} - output lands here once generated`}>
                              {stage.format}
                            </span>
                          );
                        }
                        return output.mediaType === "image" ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={output.id} src={output.outputUrl} alt={output.label} className="h-11 w-11 shrink-0 rounded-lg object-cover ring-1 ring-border" loading="lazy" />
                        ) : (
                          <span key={output.id} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-black font-mono text-[9px] text-white ring-1 ring-border">
                            video
                          </span>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {error && <p role="alert" className="mt-3 break-words text-[12px] text-rose-600 dark:text-rose-300">{error}</p>}

      <div className="mt-3 border-t border-border pt-3">
        {hasMotion && !confirming && selectedStages.length > 0 && (
          <p className="mb-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-muted-foreground">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden />
            Selection includes video - slower and costlier than image. The confirm step breaks down the cost before anything spends.
          </p>
        )}
        {campaign.jobs.length === 0 && selectable.length > 0 ? (
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Nothing generated yet - select the deliverables for this pack, then generate. Only approved stages can run.
          </p>
        ) : selectable.length === 0 && campaign.jobs.length > 0 ? (
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {hasBlockedStages
              ? "Generation has settled, but some outputs need a ratio review - regenerate them from Review & deliver before approval."
              : "Every approved stage has completed - review the outputs below or refine individual assets."}
          </p>
        ) : null}
        <Button
          onClick={() => setConfirming(true)}
          disabled={!allowed || busy || selectedStages.length === 0}
          aria-busy={busy}
          title={!allowed ? "Generation is locked until the permission check passes" : selectedStages.length === 0 ? "Select at least one deliverable" : undefined}
          className="mt-3 w-full rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 disabled:opacity-50 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
        >
          <Sparkles className="h-4 w-4" aria-hidden />
          {busy ? "Starting…" : `Generate selected assets${selectedStages.length > 0 ? ` (${selectedStages.length})` : ""}`}
        </Button>
        {filmMode === "campaign_film" && (
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
            This generates the current asset pack. Film generation will be available after you save and submit the film plan.
          </p>
        )}
        {!allowed && (
          <p className="mt-2 flex items-start gap-1.5 text-[12px] text-rose-600 dark:text-rose-300">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Blocked - fix the rights issue before anything can generate.
          </p>
        )}
      </div>

      {confirming && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4" role="presentation">
          <div className="absolute inset-0 bg-black/50" onClick={() => !busy && setConfirming(false)} aria-hidden />
          <div role="alertdialog" aria-modal="true" aria-labelledby="studio-generate-title" className="relative w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl">
            <h2 id="studio-generate-title" className="text-[15px] font-semibold tracking-tight">
              Generate {selectedStages.length} stage{selectedStages.length === 1 ? "" : "s"}?
            </h2>
            <ul className="mt-3 space-y-1.5">
              {selectedStages.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 text-[13px]">
                  <span className="min-w-0 truncate" title={s.kind === "image-to-video" && s.durationNote ? s.durationNote : undefined}>
                    {s.label}
                    {s.kind === "image-to-video" && s.durationSeconds !== undefined && (
                      <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                        {s.durationSeconds}s
                        {s.requestedDurationSeconds !== undefined && s.requestedDurationSeconds !== s.durationSeconds && (
                          <> (requested {s.requestedDurationSeconds}s)</>
                        )}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{formatUsd(estimateStages([s]))} est.</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 space-y-1 rounded-xl bg-muted/60 p-3.5 text-[12.5px] leading-relaxed ring-1 ring-border">
              <p>
                <span className="font-medium">
                  {liveEstimate && liveEstimate.exact
                    ? `Live estimate ${formatUsd(liveEstimate.total)}`
                    : livePrices
                      ? "Live pricing unavailable for this selection"
                      : `Estimated spend ${formatUsd(estimate)}`}
                </span>{" "}
                · {formatUsd(spent)} spent so far on this campaign.
              </p>
              <p className="text-muted-foreground">Generation spend is non-refundable once a stage runs. Only approved stages are queued - anything unselected stays untouched.</p>
              {hasMotion && (
                <p className="text-muted-foreground">Video stages can take several minutes. Generation runs on the server - safe to leave this page; progress is saved per finished stage.</p>
              )}
            </div>
            {error && <p role="alert" className="mt-3 break-words text-[12px] text-rose-600 dark:text-rose-300">{error}</p>}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy} className="rounded-full">
                Keep editing
              </Button>
              <Button
                onClick={() => void generate()}
                disabled={busy}
                aria-busy={busy}
                className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
              >
                {busy ? "Starting…" : liveEstimate && liveEstimate.exact ? `Confirm · ${formatUsd(liveEstimate.total)}` : `Confirm · ${formatUsd(estimate)} est.`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
