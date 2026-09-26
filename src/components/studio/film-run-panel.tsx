"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Clapperboard, Loader2, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApiError, apiGet, apiPost } from "@/lib/api";
import { newRunKey } from "@/lib/idempotency-key";
import { useInvalidateWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import { useFilmRunProgress } from "@/lib/use-film-run-progress";
import { cn } from "@/lib/utils";
import type { Campaign } from "@/server/types";
import { FILM_RUN_LABELS, type FilmRun, type FilmRunStatus } from "@/server/livepeer/film-run";
import { FilmCaptionPanel } from "./film-caption-panel";
import { FilmNarrationPanel } from "./film-narration-panel";

interface FilmRunPanelProps {
  campaign: Campaign;
  allowed: boolean;
  onChanged: () => Promise<void>;
}

/** Badge tones reuse the short-asset queue language; states stay film-specific. */
const BADGE: Record<FilmRunStatus, string> = {
  confirmed: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800",
  submitting: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800",
  generating_scenes: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800",
  assembling_reel: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-800",
  ready: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800",
  failed: "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-800",
  cancelled: "bg-muted text-muted-foreground ring-border"
};

function isTerminalStatus(status: FilmRunStatus): boolean {
  return status === "ready" || status === "failed" || status === "cancelled";
}

interface PendingFilmSubmit {
  key: string;
  plan: string;
}

function pendingSubmitStorageKey(campaignId: string): string {
  return `permitframe:film-submit:${campaignId}`;
}

function readPendingSubmit(campaignId: string): PendingFilmSubmit | null {
  try {
    const raw = sessionStorage.getItem(pendingSubmitStorageKey(campaignId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingFilmSubmit;
    return typeof parsed.key === "string" && typeof parsed.plan === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function savePendingSubmit(campaignId: string, attempt: PendingFilmSubmit | null): void {
  try {
    if (attempt) sessionStorage.setItem(pendingSubmitStorageKey(campaignId), JSON.stringify(attempt));
    else sessionStorage.removeItem(pendingSubmitStorageKey(campaignId));
  } catch {
    // The server's active-run guard still prevents a second active run if
    // browser storage is disabled.
  }
}

function SceneOutput({ url }: { url: string }) {
  if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(url)) {
    return <p className="mt-1 rounded-md bg-amber-50 px-2 py-1.5 text-[10.5px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
      Provider returned a still image, not a deliverable scene video. This clip must be retried.
    </p>;
  }
  return <video src={url} controls preload="metadata" className="mt-1 aspect-video w-full rounded-lg bg-black" />;
}

/**
 * Film execution panel: submit the saved plan, follow runs, review the
 * reel. Planned scenes and provider-returned outputs are labeled as such -
 * outputs appear only when the provider actually returns them, and the
 * reel card renders only for a verified HTTPS reel URL. Short-asset queue
 * rows are never read or written here.
 */
export function FilmRunPanel({ campaign, allowed, onChanged }: FilmRunPanelProps) {
  const savedPlan = campaign.request.filmPlan ?? null;
  const runs = [...(campaign.filmRuns ?? [])].reverse();
  const activeRun = runs.find((r) => !isTerminalStatus(r.status)) ?? null;
  // Keep the working surface focused on the active run, or the most recent
  // settled attempt. Older attempts remain available as audit history rather
  // than competing with the current action.
  const primaryRun = activeRun ?? runs[0] ?? null;
  const previousRuns = primaryRun ? runs.filter((run) => run.id !== primaryRun.id) : [];
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmingSubmit, setConfirmingSubmit] = useState(false);
  const [recoveryVersion, setRecoveryVersion] = useState(0);
  const [acknowledgedRunId, setAcknowledgedRunId] = useState<string | null>(null);
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();
  useFilmRunProgress(campaign.id, activeRun?.id ?? acknowledgedRunId, onChanged);
  const savedPlanSignature = savedPlan ? JSON.stringify(savedPlan) : "";
  const knownRunIds = runs.map((run) => run.id).join(",");
  const changedRef = useRef(onChanged);
  useEffect(() => { changedRef.current = onChanged; }, [onChanged]);

  // A browser timeout is not proof that the server rejected the submit.
  // Reconcile the same key after a reload before inviting another paid run.
  useEffect(() => {
    const pending = readPendingSubmit(campaign.id);
    if (!pending || pending.plan !== savedPlanSignature) return;
    if (runs.some((run) => run.idempotencyKey === pending.key)) {
      savePendingSubmit(campaign.id, null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let checks = 0;
    const check = async () => {
      try {
        const result = await apiGet<{ found: boolean; filmRunId: string | null }>(
          `/api/campaigns/${campaign.id}/film-runs?idempotencyKey=${encodeURIComponent(pending.key)}`,
          undefined,
          12000
        );
        if (cancelled) return;
        if (result.found) {
          savePendingSubmit(campaign.id, null);
          setAcknowledgedRunId(result.filmRunId);
          setNote("Film run found after the delayed response. Following its progress.");
          invalidateSnapshot();
          void changedRef.current();
          return;
        }
      } catch {
        // Keep the key: pressing Submit again safely replays this attempt.
      }
      if (cancelled) return;
      checks += 1;
      if (checks < 4) timer = setTimeout(() => void check(), 4000);
      else setNote("The film run has not been saved yet. You can press Submit again; the same request key will be reused.");
    };
    void check();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // Run ids are a stable content signature; changes end recovery as soon
    // as the submitted run appears in the campaign snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign.id, savedPlanSignature, knownRunIds, recoveryVersion]);

  async function submit() {
    if (busy || !savedPlan) return;
    setBusy("submit");
    setError(null);
    setNote(null);
    const stored = readPendingSubmit(campaign.id);
    const alreadySettled = runs.some((run) => run.idempotencyKey === stored?.key && isTerminalStatus(run.status));
    const attempt = stored?.plan === savedPlanSignature && !alreadySettled
      ? stored
      : { key: newRunKey("film"), plan: savedPlanSignature };
    savePendingSubmit(campaign.id, attempt);
    // The server acknowledges only after the run has been saved.
    const handoffTimer = setTimeout(() => {
      setConfirmingSubmit(false);
      setNote("Still waiting for the saved film run. You can refresh; this request will be recovered by its key.");
      invalidateSnapshot();
      void onChanged().catch(() => undefined);
    }, 10_000);
    try {
      const result = await apiPost<{ started: boolean; filmRunId: string; created: boolean }>(
        `/api/campaigns/${campaign.id}/film-runs`,
        { idempotencyKey: attempt.key },
        undefined,
        90_000
      );
      clearTimeout(handoffTimer);
      setConfirmingSubmit(false);
      savePendingSubmit(campaign.id, null);
      setAcknowledgedRunId(result.filmRunId);
      setNote(result.created ? "Film run submitted - the provider job is being dispatched." : "That film run already exists - following it instead of submitting again.");
      invalidateSnapshot();
      void onChanged().catch(() => undefined);
    } catch (e) {
      clearTimeout(handoffTimer);
      // The durable run may have been created after the browser timed out
      // waiting for the response. Re-read once before inviting another paid
      // submission; the server's active-run/idempotency guards remain the
      // authority if this request is still completing.
      if (e instanceof ApiError && e.status === 0) {
        setConfirmingSubmit(false);
        setNote("The submission response timed out. Checking the saved request; retrying will reuse the same key.");
        setRecoveryVersion((version) => version + 1);
        invalidateSnapshot();
        void onChanged().catch(() => undefined);
        return;
      }
      setError(e instanceof Error ? e.message : "Film submit failed. Nothing was submitted.");
    } finally {
      clearTimeout(handoffTimer);
      setBusy(null);
    }
  }

  async function retry(filmRunId: string) {
    if (busy) return;
    setBusy(`retry-${filmRunId}`);
    setError(null);
    setNote(null);
    try {
      await apiPost(`/api/campaigns/${campaign.id}/film-runs/${filmRunId}/retry`, {}, undefined, 30000);
      setNote("Film run resumed. Completed scene clips are kept; only failed scene clips or final assembly will retry.");
      invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Film retry failed to start.");
    } finally {
      setBusy(null);
    }
  }

  async function cancel(filmRunId: string) {
    if (busy) return;
    setBusy(`cancel-${filmRunId}`);
    setError(null);
    setNote(null);
    try {
      const result = await apiPost<{ ok: boolean; note: string }>(
        `/api/campaigns/${campaign.id}/film-runs/${filmRunId}/cancel`,
        {},
        undefined,
        // Cancellation is a local state transition first. A long browser
        // spinner is misleading, especially when no provider job was ever
        // accepted; refresh can safely reconcile a late response.
        15000
      );
      setNote(result.note);
      invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Film cancel failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label="Film execution" className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <h3 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
        <Clapperboard className="h-4 w-4" aria-hidden />
        Film execution
      </h3>

      {!savedPlan && (
        <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">
          No saved film plan yet - plan and confirm the scenes above, then submit the film for generation here.
        </p>
      )}

      {savedPlan && (
        <div className="mt-3 rounded-xl bg-muted/60 p-3 ring-1 ring-border">
          <p className="text-[13px] font-semibold">{savedPlan.title}</p>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            {savedPlan.targetDurationSeconds}s · {savedPlan.scenes.length} planned scenes · {savedPlan.aspectRatio} · Budget cap ${savedPlan.budgetCapUsd.toFixed(2)} maximum
          </p>
          <div className="mt-2.5">
            <Button
              onClick={() => setConfirmingSubmit(true)}
              disabled={!allowed || busy !== null || activeRun !== null}
              title={
                !allowed
                  ? "Locked until the permission check passes"
                  : activeRun
                    ? "A film run is already active - wait for it to settle first"
                    : undefined
              }
              className="w-full rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 disabled:opacity-50 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
            >
              {busy === "submit" ? "Submitting…" : "Submit film for generation"}
            </Button>
            <p className="mt-1.5 text-center text-[10.5px] leading-snug text-muted-foreground">
              Submitting dispatches a paid provider job inside your confirmed budget cap.
            </p>
          </div>
        </div>
      )}

      {error && <p role="alert" className="mt-2 break-words text-[12.5px] text-rose-600 dark:text-rose-300">{error}</p>}
      {note && <p role="status" className="mt-2 break-words text-[12.5px] text-emerald-800 dark:text-emerald-200">{note}</p>}

      {runs.length > 0 && (
        <div className="mt-3 space-y-3">
          {primaryRun && (
            <ol>
              <FilmRunCard
                key={primaryRun.id}
                campaignId={campaign.id}
                run={primaryRun}
                allowed={allowed}
                busy={busy}
                onRetry={() => void retry(primaryRun.id)}
                onCancel={() => void cancel(primaryRun.id)}
                onChanged={onChanged}
              />
            </ol>
          )}
          {previousRuns.length > 0 && (
            <details className="rounded-xl border border-border bg-muted/30 px-3 py-2.5">
              <summary className="cursor-pointer text-[12px] font-medium text-muted-foreground hover:text-foreground">
                Previous attempts ({previousRuns.length})
              </summary>
              <p className="mt-1 text-[10.5px] text-muted-foreground">
                Kept for audit and cost history. They do not affect the current run.
              </p>
              <ol className="mt-2 space-y-3">
                {previousRuns.map((run) => (
                  <FilmRunCard
                    key={run.id}
                    campaignId={campaign.id}
                    run={run}
                    allowed={allowed}
                    busy={busy}
                    onRetry={() => void retry(run.id)}
                    onCancel={() => void cancel(run.id)}
                    onChanged={onChanged}
                  />
                ))}
              </ol>
            </details>
          )}
        </div>
      )}

      {confirmingSubmit && savedPlan && (
        <FilmSubmitConfirm
          title={savedPlan.title}
          sceneCount={savedPlan.scenes.length}
          totalSeconds={savedPlan.targetDurationSeconds}
          format={savedPlan.aspectRatio}
          budgetCapUsd={savedPlan.budgetCapUsd}
          busy={busy === "submit"}
          onConfirm={() => void submit()}
          onCancel={() => setConfirmingSubmit(false)}
        />
      )}
    </section>
  );
}

function FilmRunCard({
  campaignId,
  run,
  allowed,
  busy,
  onRetry,
  onCancel,
  onChanged
}: {
  campaignId: string;
  run: FilmRun;
  allowed: boolean;
  busy: string | null;
  onRetry: () => void;
  onCancel: () => void;
  onChanged: () => Promise<void>;
}) {
  const active = !isTerminalStatus(run.status);
  const retryable = run.status === "failed" && !run.providerJobId;
  return (
    <li className="rounded-xl border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[13px] font-semibold">{run.filmTitle}</p>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium ring-1", BADGE[run.status])}>
          {FILM_RUN_LABELS[run.status]}
        </span>
      </div>
      <p className="mt-0.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground">
        {run.targetDurationSeconds}s requested · {run.plannedScenes.length} scenes · {run.actualCapability ?? run.requestedCapability}
      </p>
      <p className="mt-1 text-[11.5px] text-muted-foreground">
        Budget cap ${run.budgetCapUsd.toFixed(2)} maximum
        {run.estimateUsd !== undefined && ` · provider estimate $${run.estimateUsd.toFixed(2)}`}
        {run.costUsd !== undefined && ` · $${run.costUsd.toFixed(2)} reported`}
      </p>
      {run.status === "submitting" && !run.providerJobId && (
        <p className="mt-1.5 rounded-lg bg-muted/60 px-2.5 py-2 text-[11.5px] leading-relaxed text-muted-foreground">
          Reserving the first source-bound scene jobs. Only two scenes are submitted at once so each uses the approved source image directly.
        </p>
      )}
      {run.status === "submitting" && run.providerJobId && (
        <p className="mt-1.5 rounded-lg bg-muted/60 px-2.5 py-2 text-[11.5px] leading-relaxed text-muted-foreground">
          Provider accepted the film job. It can take several minutes to start scene generation and assemble the final reel.
        </p>
      )}
      {active && (
        <section className="mt-2 rounded-lg border border-border bg-muted/40 px-2.5 py-2" aria-label="Film generation queue">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11.5px]">
            <span className="font-medium">Film queue</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
              {run.sceneOutputs.filter((scene) => Boolean(scene.url)).length}/{run.plannedScenes.length} scene outputs returned
            </span>
          </div>
          <p className="mt-0.5 text-[10.5px] text-muted-foreground">
            {`Provider status: ${run.providerStatus ?? "preparing source-bound scene jobs"}`}
          </p>
          {run.providerViewerUrl && (
            <a
              href={run.providerViewerUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-[10.5px] font-medium text-sky-700 underline underline-offset-2 dark:text-sky-300"
            >
              Open provider progress inspector
            </a>
          )}
        </section>
      )}
      {run.error && <p role="alert" className="mt-1.5 break-words text-[12px] text-rose-600 dark:text-rose-300">{run.error}</p>}

      <details className="mt-2 text-[12px]" open={active}>
        <summary className="cursor-pointer font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          Planned scenes ({run.plannedScenes.length})
        </summary>
        <ul className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {run.plannedScenes.map((s) => {
            const output = run.sceneOutputs.find((o) => o.index === s.order - 1 || o.title === s.title);
            return (
              <li key={s.id} className="rounded-lg bg-muted/60 px-2.5 py-1.5 ring-1 ring-border">
                <p className="flex items-baseline justify-between gap-2 text-[12px]">
                  <span className="min-w-0 truncate">
                    <span className="mr-1.5 font-mono text-[10px] text-muted-foreground">{s.order}.</span>
                    {s.title}
                  </span>
                  <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{s.durationSeconds}s planned</span>
                </p>
                {output?.url ? (
                  <div>
                    <p className="mt-0.5 text-[10.5px] font-medium text-emerald-800 dark:text-emerald-200">
                      {output.status ? `Provider: ${output.status}` : "Provider video output"}
                    </p>
                    <SceneOutput url={output.url} />
                  </div>
                ) : output?.status ? (
                  <div>
                    <p className="mt-0.5 text-[10.5px] text-amber-700 dark:text-amber-300">Provider: {output.status}</p>
                    {output.error && <p className="mt-1 break-words text-[10.5px] leading-snug text-rose-600 dark:text-rose-300">{output.error}</p>}
                  </div>
                ) : (
                  active && (
                    <p className="mt-0.5 text-[10.5px] text-muted-foreground">Output appears here only when the provider returns it.</p>
                  )
                )}
              </li>
            );
          })}
        </ul>
      </details>

      {run.status === "ready" && run.reelUrl && (
        <div className="mt-2 overflow-hidden rounded-xl bg-muted/60 ring-1 ring-border">
          <video src={run.reelUrl} controls preload="metadata" className="aspect-video w-full bg-black" />
          <div className="space-y-1 p-3">
            <p className="text-[12.5px] font-medium leading-tight">Campaign film reel · {run.targetDurationSeconds}s requested</p>
            <p className="text-[10.5px] text-muted-foreground">
              Built by stitching source-bound scene videos. Outputs still require review; no identity preservation is claimed.
            </p>
          </div>
        </div>
      )}
      {run.status === "ready" && run.sceneOutputs.length === 0 && (
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
          Final reel delivered; individual scene outputs were not returned by the provider.
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        {retryable && (
          <Button
            variant="outline"
            onClick={onRetry}
            disabled={!allowed || busy !== null}
            className="rounded-full text-[12px]"
          >
            {busy === `retry-${run.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden />}
            Resume film run
          </Button>
        )}
        {active && (
          <Button
            variant="outline"
            onClick={onCancel}
            disabled={!allowed || busy !== null}
            className="rounded-full text-[12px]"
          >
            {busy === `cancel-${run.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
            Cancel film run
          </Button>
        )}
      </div>
      {run.status === "failed" && run.providerJobId && (
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
          The provider job ended - resuming cannot recover it. Submit a new film run for a fresh provider job.
        </p>
      )}
      <FilmCaptionPanel campaignId={campaignId} run={run} allowed={allowed} onChanged={onChanged} />
      <FilmNarrationPanel campaignId={campaignId} run={run} allowed={allowed} onChanged={onChanged} />
      {run.status === "ready" && typeof run.reelUrl === "string" && (
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
          After delivery: use Add narration or Burn captions above for this reel. Music and soundtrack mixing are not available yet.
        </p>
      )}
    </li>
  );
}

function FilmSubmitConfirm({
  title,
  sceneCount,
  totalSeconds,
  format,
  budgetCapUsd,
  busy,
  onConfirm,
  onCancel
}: {
  title: string;
  sceneCount: number;
  totalSeconds: number;
  format: string;
  budgetCapUsd: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      triggerRef.current?.focus?.();
    };
  }, [onCancel, busy]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="presentation">
      <div className="absolute inset-0 bg-black/50" onClick={() => !busy && onCancel()} aria-hidden />
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="relative w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl">
        <h2 id={titleId} className="text-[15px] font-semibold tracking-tight">
          Submit “{title}” for generation?
        </h2>
        <dl className="mt-4 space-y-2 rounded-xl bg-muted/60 p-4 text-[12.5px] ring-1 ring-border">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Scenes</dt>
            <dd className="font-medium">{sceneCount} planned</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Total duration</dt>
            <dd className="font-mono font-medium">{totalSeconds}s</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Format</dt>
            <dd className="font-mono font-medium">{format}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Budget cap</dt>
            <dd className="font-mono font-medium">${budgetCapUsd.toFixed(2)} maximum</dd>
          </div>
        </dl>
        <p className="mt-3 text-[12.5px] leading-relaxed text-muted-foreground">
          Submitting dispatches a paid provider job inside the ${budgetCapUsd.toFixed(2)} maximum - this is a
          spending cap, not an estimate or quote. Each scene renders separately; final reel delivery depends on
          the provider job succeeding.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" ref={cancelRef} onClick={onCancel} disabled={busy} className="rounded-full">
            Keep editing
          </Button>
          <Button
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy}
            className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 disabled:opacity-50 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
          >
            {busy ? "Submitting…" : "Submit film run"}
          </Button>
        </div>
      </div>
    </div>
  );
}
