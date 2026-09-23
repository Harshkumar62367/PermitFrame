"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AudioLines, Loader2, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiPost } from "@/lib/api";
import { newRunKey } from "@/lib/idempotency-key";
import { useInvalidateWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import { useFilmNarrationProgress } from "@/lib/use-film-narration-progress";
import { cn } from "@/lib/utils";
import {
  estimateNarrationSeconds,
  FILM_NARRATION_LABELS,
  NARRATION_OUTCOME_UNKNOWN_COPY,
  NARRATION_RECOVERY_CONFIRM_COPY,
  NARRATION_SCRIPT_MAX_CHARS,
  narrationDisplayStatus,
  type FilmNarrationJob,
  type FilmNarrationStatus
} from "@/server/livepeer/narration-policy";
import type { FilmRun } from "@/server/livepeer/film-run";

interface FilmNarrationPanelProps {
  campaignId: string;
  run: FilmRun;
  allowed: boolean;
  onChanged: () => Promise<void>;
}

const BADGE: Record<FilmNarrationStatus, string> = {
  queued: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800",
  generating_narration: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800",
  waiting_for_narration: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800",
  muxing: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-800",
  ready: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800",
  failed: "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-800",
  cancelled: "bg-muted text-muted-foreground ring-border",
  outcome_unknown: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800"
};

function isTerminalStatus(status: FilmNarrationStatus): boolean {
  return status === "ready" || status === "failed" || status === "cancelled" || status === "outcome_unknown";
}

/**
 * Narrated-reel finishing on a delivered reel. Opt-in only: the action
 * appears solely on completed runs, confirmation requires a script plus
 * a positive cap, and the default state reads "No added audio." Narration
 * jobs render their own states; the narrated file - when one lands - is a
 * new private derivative, never an overwrite. No music, mixing, voice
 * picker, or lip-sync anywhere in this flow.
 */
export function FilmNarrationPanel({ campaignId, run, allowed, onChanged }: FilmNarrationPanelProps) {
  const jobs = run.narrationJobs ?? [];
  const [confirming, setConfirming] = useState(false);
  const [confirmingRecovery, setConfirmingRecovery] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();
  useFilmNarrationProgress(campaignId, run.id, run.narrationJobs, onChanged);

  const eligible = run.status === "ready" && typeof run.reelUrl === "string";
  if (!eligible && jobs.length === 0) return null;

  async function retry(narrationJobId: string) {
    if (busy) return;
    setBusy(`retry-${narrationJobId}`);
    setError(null);
    setNote(null);
    try {
      await apiPost(
        `/api/campaigns/${campaignId}/film-runs/${run.id}/narrations/${narrationJobId}/retry`,
        {},
        undefined,
        30000
      );
      setNote("Narration job resumed - no provider job was tracked, so this submits a fresh call.");
      invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Narration retry failed to start.");
    } finally {
      setBusy(null);
    }
  }

  async function cancel(narrationJobId: string) {
    if (busy) return;
    setBusy(`cancel-${narrationJobId}`);
    setError(null);
    setNote(null);
    try {
      const result = await apiPost<{ ok: boolean; note: string }>(
        `/api/campaigns/${campaignId}/film-runs/${run.id}/narrations/${narrationJobId}/cancel`,
        {},
        undefined,
        60000
      );
      setNote(result.note);
      invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Narration cancel failed.");
    } finally {
      setBusy(null);
    }
  }

  async function recover(narrationJobId: string) {
    setConfirmingRecovery(null);
    setBusy(`recover-${narrationJobId}`);
    setError(null);
    setNote(null);
    try {
      await apiPost(
        `/api/campaigns/${campaignId}/film-runs/${run.id}/narrations/${narrationJobId}/recover`,
        {},
        undefined,
        60000
      );
      setNote("A fresh narration request was queued - the prior request is preserved as outcome-unknown.");
      invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Narration recovery failed. Nothing was changed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-2 border-t border-border pt-2">
      <p className="text-[11.5px] font-medium text-muted-foreground">Narration</p>
      {jobs.length === 0 && (
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">No added audio.</p>
      )}
      {eligible && (
        <Button
          variant="outline"
          onClick={() => setConfirming(true)}
          disabled={!allowed || busy !== null}
          title={!allowed ? "Locked until the permission check passes" : undefined}
          className="mt-1.5 w-full rounded-full text-[12px]"
        >
          <AudioLines className="h-3.5 w-3.5" aria-hidden />
          Add narration
        </Button>
      )}
      {error && <p role="alert" className="mt-1.5 break-words text-[12px] text-rose-600 dark:text-rose-300">{error}</p>}
      {note && <p role="status" className="mt-1.5 break-words text-[12px] text-emerald-800 dark:text-emerald-200">{note}</p>}

      {jobs.length > 0 && (
        <ul className="mt-2 space-y-2">
          {jobs.map((job) => (
            <NarrationJobCard
              key={job.id}
              job={job}
              reelSeconds={run.targetDurationSeconds}
              allowed={allowed}
              busy={busy}
              onRetry={() => void retry(job.id)}
              onCancel={() => void cancel(job.id)}
              onRecover={() => setConfirmingRecovery(job.id)}
            />
          ))}
        </ul>
      )}

      {confirmingRecovery && (
        <RecoveryConfirm
          busy={busy === `recover-${confirmingRecovery}`}
          onConfirm={() => void recover(confirmingRecovery)}
          onCancel={() => setConfirmingRecovery(null)}
        />
      )}

      {confirming && (
        <NarrationConfirm
          campaignId={campaignId}
          filmRunId={run.id}
          reelSeconds={run.targetDurationSeconds}
          busy={busy === "submit"}
          onDone={(message, failed) => {
            setConfirming(false);
            if (failed) setError(message);
            else setNote(message);
            invalidateSnapshot();
            void onChanged().finally(() => setBusy(null));
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

function NarrationJobCard({
  job,
  reelSeconds,
  allowed,
  busy,
  onRetry,
  onCancel,
  onRecover
}: {
  job: FilmNarrationJob;
  reelSeconds: number;
  allowed: boolean;
  busy: string | null;
  onRetry: () => void;
  onCancel: () => void;
  onRecover: () => void;
}) {
  const active = !isTerminalStatus(job.status);
  const retryable = job.status === "failed" && !job.ttsJobId && !job.muxJobId;
  // Derived display: a stale claimed job renders outcome-unknown while the
  // stored record keeps its last known state until explicit recovery.
  const display = narrationDisplayStatus(job);
  const recoverable = display === "outcome_unknown" && job.status !== "outcome_unknown";
  return (
    <li className="rounded-lg bg-muted/60 px-2.5 py-2 ring-1 ring-border">
      <p className="flex items-center justify-between gap-2 text-[12px]">
        <span className="font-medium">Narration · ~{job.estimatedSeconds}s of {reelSeconds}s reel</span>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium ring-1", BADGE[display])}>
          {FILM_NARRATION_LABELS[display]}
        </span>
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        Cap ${job.narrationCapUsd.toFixed(2)} maximum
        {" · "}Cost: {job.ttsCostUsd !== undefined || job.muxCostUsd !== undefined
          ? `$${((job.ttsCostUsd ?? 0) + (job.muxCostUsd ?? 0)).toFixed(2)} reported`
          : "unavailable"}
      </p>
      {job.error && display !== "outcome_unknown" && (
        <p role="alert" className="mt-1 break-words text-[11.5px] text-rose-600 dark:text-rose-300">{job.error}</p>
      )}
      {display === "outcome_unknown" && (
        <p role="status" className="mt-1.5 break-words text-[11.5px] font-medium leading-relaxed text-amber-700 dark:text-amber-300">
          {NARRATION_OUTCOME_UNKNOWN_COPY}
        </p>
      )}
      {job.status === "ready" && job.narratedUrl && (
        <div className="mt-1.5">
          <video src={job.narratedUrl} controls preload="metadata" className="aspect-video w-full rounded-lg bg-black" />
          <p className="mt-1 text-[10.5px] text-muted-foreground">
            Narrated derivative - saved as a linked receipt in Review. The original reel is unchanged.
          </p>
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap gap-2">
        {retryable && (
          <Button variant="outline" onClick={onRetry} disabled={!allowed || busy !== null} className="rounded-full text-[11.5px]">
            {busy === `retry-${job.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden />}
            Retry narration
          </Button>
        )}
        {active && (
          <Button variant="outline" onClick={onCancel} disabled={!allowed || busy !== null} className="rounded-full text-[11.5px]">
            {busy === `cancel-${job.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
            Cancel narration
          </Button>
        )}
        {recoverable && (
          <Button variant="outline" onClick={onRecover} disabled={!allowed || busy !== null} className="rounded-full text-[11.5px]">
            {busy === `recover-${job.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden />}
            Start a new narration request
          </Button>
        )}
      </div>
    </li>
  );
}

function NarrationConfirm({
  campaignId,
  filmRunId,
  reelSeconds,
  busy,
  onDone,
  onCancel
}: {
  campaignId: string;
  filmRunId: string;
  reelSeconds: number;
  busy: boolean;
  onDone: (message: string, failed: boolean) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [script, setScript] = useState("");
  const [cap, setCap] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy && !submitting) onCancel();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      triggerRef.current?.focus?.();
    };
  }, [onCancel, busy, submitting]);

  const normalized = script.replace(/\s+/g, " ").trim();
  const estimated = normalized ? estimateNarrationSeconds(normalized.length) : 0;
  const tooLong = normalized.length > NARRATION_SCRIPT_MAX_CHARS;
  const capNum = cap.trim() === "" ? NaN : Number(cap);
  const capValid = Number.isFinite(capNum) && capNum > 0;
  const fits = !normalized || estimated <= reelSeconds;
  const canConfirm = normalized.length > 0 && !tooLong && capValid && fits && !busy && !submitting;

  async function confirm() {
    if (!canConfirm) return;
    setSubmitting(true);
    try {
      await apiPost(
        `/api/campaigns/${campaignId}/film-runs/${filmRunId}/narrations`,
        { script: normalized, narrationCapUsd: capNum, idempotencyKey: newRunKey("filmnar") },
        undefined,
        30000
      );
      onDone("Narration job submitted - generating voiceover for the delivered reel.", false);
    } catch (e) {
      onDone(e instanceof Error ? e.message : "Narration submit failed. Nothing was submitted.", true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="presentation">
      <div className="absolute inset-0 bg-black/50" onClick={() => !busy && !submitting && onCancel()} aria-hidden />
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-card p-6 shadow-2xl">
        <h2 id={titleId} className="text-[15px] font-semibold tracking-tight">
          Add narration to a copy?
        </h2>
        <div className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
          <p>This creates a new private narrated-video derivative. Your original reel will remain unchanged.</p>
          <p>Narration is generated first. PermitFrame adds it to the reel only after a usable audio file is returned.</p>
          <p>Your narration cap is a hard maximum for this request.</p>
          <p>The narrated derivative is not included in client delivery.</p>
        </div>
        <label className="mt-3 block">
          <span className="text-[12px] font-medium text-muted-foreground">Narration script (plain text, required)</span>
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={4}
            maxLength={NARRATION_SCRIPT_MAX_CHARS + 100}
            placeholder="Say what the reel should say…"
            aria-label="Narration script"
            className="mt-1.5 w-full rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] focus:border-emerald-500/50 focus:outline-none"
          />
        </label>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground" aria-live="polite">
          {normalized.length}/{NARRATION_SCRIPT_MAX_CHARS.toLocaleString()} characters
          {normalized && ` · ≈${estimated}s spoken (estimate)`}
          {tooLong && " · over the 1,500-character PermitFrame product safeguard (not a provider limit)"}
          {normalized && !fits && " · likely longer than the reel"}
        </p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-[12px] font-medium text-muted-foreground">Max spend cap (USD, required)</span>
            <input
              type="number"
              min={0.1}
              step={0.5}
              value={cap}
              placeholder="e.g. 5"
              onChange={(e) => setCap(e.target.value)}
              aria-label="Narration spend cap in USD"
              className="mt-1.5 w-full rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] focus:border-emerald-500/50 focus:outline-none"
            />
          </label>
          <div className="text-[11px] leading-relaxed text-muted-foreground">
            <p>Voice is selected by the provider for this first version.</p>
            <p className="mt-1">Cost estimate unavailable. Your cap is enforced before each provider request.</p>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" ref={cancelRef} onClick={onCancel} disabled={busy || submitting} className="rounded-full">
            Keep as is
          </Button>
          <Button
            onClick={() => void confirm()}
            disabled={!canConfirm}
            aria-busy={submitting}
            title={!normalized ? "Write a narration script first" : !capValid ? "Enter a positive spend cap" : !fits ? "Shorten the script to fit the reel" : undefined}
            className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 disabled:opacity-50 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
          >
            {submitting ? "Submitting…" : "Add narration"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function RecoveryConfirm({
  busy,
  onConfirm,
  onCancel
}: {
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
          Start a new narration request?
        </h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
          {NARRATION_RECOVERY_CONFIRM_COPY}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" ref={cancelRef} onClick={onCancel} disabled={busy} className="rounded-full">
            Keep as is
          </Button>
          <Button
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy}
            className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 disabled:opacity-50 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
          >
            {busy ? "Starting…" : "Start a new narration request"}
          </Button>
        </div>
      </div>
    </div>
  );
}
