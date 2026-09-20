"use client";

import { useMemo, useState } from "react";
import { Check, CircleDashed, Loader2, Sparkles, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiPost } from "@/lib/api";
import { useInvalidateWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import { cn } from "@/lib/utils";
import type { Campaign, ProductionStagePlan } from "@/server/types";
import {
  deliverableKind,
  deliverableState,
  estimateStages,
  formatUsd,
  hasUnknownPrice,
  planDeliverables,
  receiptsForStages,
  recommendInitialStages,
  type DeliverableState
} from "./studio-model";

interface CreativePlanProps {
  campaign: Campaign;
  allowed: boolean;
  onChanged: () => Promise<void>;
}

const STATE_META: Record<DeliverableState, { label: string; className: string }> = {
  ready: { label: "Not started", className: "bg-muted text-muted-foreground" },
  queued: { label: "Queued", className: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800" },
  running: { label: "Generating", className: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800" },
  partial: { label: "Partial", className: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800" },
  done: { label: "Complete", className: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800" },
  failed: { label: "Needs retry", className: "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-800" }
};

/**
 * Main panel: the approved creative plan as selectable deliverables.
 * Selection is honest — only the selected plan stages are sent to the
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
      title={label === "Image" ? "Image generation" : "Includes video — slower and costlier than image"}
    >
      {label}
    </span>
  );
}
export function CreativePlan({ campaign, allowed, onChanged }: CreativePlanProps) {
  const deliverables = useMemo(() => planDeliverables(campaign), [campaign]);
  const succeededStageIds = useMemo(
    () => new Set(campaign.jobs.filter((j) => j.status === "succeeded").map((j) => j.stageId)),
    [campaign]
  );
  const [selected, setSelected] = useState<string[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();

  const selectable = deliverables.flatMap((d) => d.stages).filter((s) => !succeededStageIds.has(s.id));
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
  const spent = campaign.jobs.filter((j) => j.status === "succeeded").reduce((s, j) => s + (j.costUsd ?? 0), 0);

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
      await apiPost(`/api/campaigns/${campaign.id}/produce`, { stageIds: selectedStages.map((s) => s.id) });
      setConfirming(false);
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
    <section aria-label="Creative plan" className="flex h-full flex-col rounded-2xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[15px] font-semibold tracking-tight">Creative plan</h3>
          <p
            className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
            title={estimateExact ? undefined : "Some stages lack catalogue prices — actual spend may be higher"}
          >
            est. {formatUsd(estimate)}{estimateExact ? "" : "+"} selected · {formatUsd(spent)} spent
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
          Recommended start: {deliverables.find((d) => d.stages.some((s) => recommendedIds.includes(s.id)))?.title ?? "one deliverable"} —
          image stages only. Video is slower and costlier — select it deliberately, never by default.
        </p>
      )}
      {deliverables.length === 0 && (
        <p className="mt-4 text-[13px] text-muted-foreground">No approved plan stages — re-check rights to rebuild the plan.</p>
      )}

      <div className="mt-4 space-y-3">
        {deliverables.map((d) => {
          const stageIds = d.stages.map((s) => s.id);
          const state = deliverableState(campaign.jobs, stageIds);
          const meta = STATE_META[state];
          const selectableIds = stageIds.filter((id) => !succeededStageIds.has(id));
          const checkedCount = selectableIds.filter((id) => selectedIds.includes(id)).length;
          const checked = selectableIds.length > 0 && checkedCount === selectableIds.length;
          const outputs = receiptsForStages(campaign.receipts, campaign.jobs, stageIds);
          return (
            <div
              key={d.id}
              className={cn(
                "rounded-xl border p-4 transition",
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
                ) : (
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-emerald-600/10 text-emerald-700 ring-1 ring-emerald-600/20 dark:text-emerald-300" aria-label={`${d.title} complete`}>
                    <Check className="h-3.5 w-3.5" aria-hidden />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[13.5px] font-semibold">{d.title}</p>
                    <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[10px] text-secondary-foreground">{d.spec}</span>
                    <KindBadge stages={d.stages} />
                    <span className="font-mono text-[10px] text-muted-foreground">{formatUsd(estimateStages(d.stages.filter((s) => !succeededStageIds.has(s.id))))} remaining</span>
                    <span className={cn("rounded-full px-2 py-0.5 text-[10.5px] font-medium ring-1", meta.className)}>{meta.label}</span>
                  </div>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">{d.platforms}</p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={`Planned capabilities: ${Array.from(new Set(d.stages.map((s) => s.capability))).join(", ")}`}>
                    via {Array.from(new Set(d.stages.map((s) => s.capability))).join(" + ")}
                  </p>
                  <ul className="mt-2 space-y-1">
                    {d.stages.map((stage) => {
                      const job = campaign.jobs.find((j) => j.stageId === stage.id);
                      const done = job?.status === "succeeded";
                      const selectableStage = !done;
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
                          ) : (
                            <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                          )}
                          <span className={cn("min-w-0 flex-1 truncate", !isChecked && selectableStage && "text-muted-foreground")}>
                            {stage.label}
                          </span>
                          {job && job.status === "running" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-600" aria-hidden />}
                          {job && job.status === "queued" && <CircleDashed className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />}
                          {job && job.status === "failed" && <X className="h-3.5 w-3.5 shrink-0 text-rose-600" aria-hidden />}
                        </li>
                      );
                    })}
                  </ul>
                  {outputs.length > 0 && (
                    <div className="mt-2.5 flex gap-2 overflow-x-auto pb-0.5">
                      {outputs.map((r) => (
                        r.mediaType === "image" ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={r.id} src={r.outputUrl} alt={r.label} className="h-14 w-14 shrink-0 rounded-lg object-cover ring-1 ring-border" loading="lazy" />
                        ) : (
                          <span key={r.id} className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-black font-mono text-[9px] text-white ring-1 ring-border">
                            video
                          </span>
                        )
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {error && <p role="alert" className="mt-3 break-words text-[12px] text-rose-600 dark:text-rose-300">{error}</p>}

      <div className="mt-4 border-t border-border pt-4">
        {hasMotion && !confirming && selectedStages.length > 0 && (
          <p className="mb-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-muted-foreground">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden />
            Selection includes video — slower and costlier than image. The confirm step breaks down the cost before anything spends.
          </p>
        )}
        {campaign.jobs.length === 0 && selectable.length > 0 ? (
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Nothing generated yet — select the deliverables for this pack, then generate. Only approved stages can run.
          </p>
        ) : selectable.length === 0 && campaign.jobs.length > 0 ? (
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Every approved stage has completed — review the outputs below or refine individual assets.
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
        {!allowed && (
          <p className="mt-2 flex items-start gap-1.5 text-[12px] text-rose-600 dark:text-rose-300">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Blocked — fix the rights issue before anything can generate.
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
                  <span className="min-w-0 truncate">{s.label}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{formatUsd(estimateStages([s]))} est.</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 space-y-1 rounded-xl bg-muted/60 p-3.5 text-[12.5px] leading-relaxed ring-1 ring-border">
              <p><span className="font-medium">Estimated spend {formatUsd(estimate)}</span> · {formatUsd(spent)} spent so far on this campaign.</p>
              <p className="text-muted-foreground">Generation spend is non-refundable once a stage runs. Only approved stages are queued — anything unselected stays untouched.</p>
              {hasMotion && (
                <p className="text-muted-foreground">Video stages can take several minutes. Generation runs on the server — safe to leave this page; progress is saved per finished stage.</p>
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
                {busy ? "Starting…" : `Confirm · ${formatUsd(estimate)} est.`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
