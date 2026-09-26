"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Captions, Loader2, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiPost } from "@/lib/api";
import { newRunKey } from "@/lib/idempotency-key";
import { useInvalidateWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import { useFilmCaptionProgress } from "@/lib/use-film-caption-progress";
import { cn } from "@/lib/utils";
import {
  CAPTION_LANGUAGES,
  FILM_CAPTION_LABELS,
  OUTCOME_UNKNOWN_COPY,
  RECOVERY_CONFIRM_COPY,
  captionDisplayStatus,
  type FilmCaptionJob,
  type FilmCaptionStatus
} from "@/server/livepeer/film-captions";
import type { FilmRun } from "@/server/livepeer/film-run";

interface FilmCaptionPanelProps {
  campaignId: string;
  run: FilmRun;
  allowed: boolean;
  onChanged: () => Promise<void>;
}

const BADGE: Record<FilmCaptionStatus, string> = {
  queued: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800",
  transcribing: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800",
  burning: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-800",
  ready: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800",
  failed: "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-800",
  cancelled: "bg-muted text-muted-foreground ring-border",
  outcome_unknown: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800"
};

function isTerminalStatus(status: FilmCaptionStatus): boolean {
  return status === "ready" || status === "failed" || status === "cancelled";
}

/**
 * Burn-captions finishing on a delivered reel. The action appears only on
 * completed runs; confirmation requires an explicit language choice and
 * states the spend reality (no pre-quote exists). Caption jobs render
 * their own states; the captioned file - when one lands - is a new
 * derivative, never an overwrite. Transcripts surface as metadata, never
 * as burned-caption claims.
 */
export function FilmCaptionPanel({ campaignId, run, allowed, onChanged }: FilmCaptionPanelProps) {
  const jobs = run.captionJobs ?? [];
  const [confirming, setConfirming] = useState(false);
  const [confirmingRecovery, setConfirmingRecovery] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();
  useFilmCaptionProgress(campaignId, run.id, run.captionJobs, onChanged);

  const eligible = run.status === "ready" && typeof run.reelUrl === "string";
  const narratedSources = (run.narrationJobs ?? [])
    .filter((job) => job.status === "ready" && job.narratedUrl)
    .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (!eligible && jobs.length === 0) return null;

  async function retry(captionJobId: string) {
    if (busy) return;
    setBusy(`retry-${captionJobId}`);
    setError(null);
    setNote(null);
    try {
      await apiPost(
        `/api/campaigns/${campaignId}/film-runs/${run.id}/captions/${captionJobId}/retry`,
        {},
        undefined,
        30000
      );
      setNote("Caption job resumed - no provider job was tracked, so this submits a fresh call.");
      invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Caption retry failed to start.");
    } finally {
      setBusy(null);
    }
  }

  async function cancel(captionJobId: string) {
    if (busy) return;
    setBusy(`cancel-${captionJobId}`);
    setError(null);
    setNote(null);
    try {
      const result = await apiPost<{ ok: boolean; note: string }>(
        `/api/campaigns/${campaignId}/film-runs/${run.id}/captions/${captionJobId}/cancel`,
        {},
        undefined,
        60000
      );
      setNote(result.note);
      invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Caption cancel failed.");
    } finally {
      setBusy(null);
    }
  }

  async function recover(captionJobId: string) {
    setConfirmingRecovery(null);
    setBusy(`recover-${captionJobId}`);
    setError(null);
    setNote(null);
    try {
      await apiPost(
        `/api/campaigns/${campaignId}/film-runs/${run.id}/captions/${captionJobId}/recover`,
        {},
        undefined,
        60000
      );
      setNote("A fresh caption request was queued - the prior request is preserved as outcome-unknown.");
      invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Caption recovery failed. Nothing was changed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-2 border-t border-border pt-2">
      {eligible && (
        <Button
          variant="outline"
          onClick={() => setConfirming(true)}
          disabled={!allowed || busy !== null}
          title={!allowed ? "Locked until the permission check passes" : undefined}
          className="w-full rounded-full text-[12px]"
        >
          <Captions className="h-3.5 w-3.5" aria-hidden />
          Burn captions
        </Button>
      )}
      {error && <p role="alert" className="mt-1.5 break-words text-[12px] text-rose-600 dark:text-rose-300">{error}</p>}
      {note && <p role="status" className="mt-1.5 break-words text-[12px] text-emerald-800 dark:text-emerald-200">{note}</p>}

      {jobs.length > 0 && (
        <ul className="mt-2 space-y-2">
          {jobs.map((job) => (
            <CaptionJobCard
              key={job.id}
              job={job}
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
        <CaptionConfirm
          busy={busy === "submit"}
          narratedSources={narratedSources}
          targetDurationSeconds={run.targetDurationSeconds}
          onConfirm={(language, narrationJobId) => {
            setConfirming(false);
            void (async () => {
              setBusy("submit");
              setError(null);
              setNote(null);
              try {
                await apiPost(
                  `/api/campaigns/${campaignId}/film-runs/${run.id}/captions`,
                  { language, narrationJobId, idempotencyKey: newRunKey("filmcap") },
                  undefined,
                  30000
                );
                setNote(`Caption job submitted - transcribing the ${narrationJobId ? "narrated copy" : "original reel"}.`);
                invalidateSnapshot();
                await onChanged();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Caption submit failed. Nothing was submitted.");
              } finally {
                setBusy(null);
              }
            })();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

function CaptionJobCard({
  job,
  allowed,
  busy,
  onRetry,
  onCancel,
  onRecover
}: {
  job: FilmCaptionJob;
  allowed: boolean;
  busy: string | null;
  onRetry: () => void;
  onCancel: () => void;
  onRecover: () => void;
}) {
  const active = !isTerminalStatus(job.status);
  const retryable = job.status === "failed" && !job.providerJobId && !job.transcriptText;
  // Derived display: a stale claimed job renders outcome-unknown while the
  // stored record keeps its last known state until explicit recovery.
  const display = captionDisplayStatus(job);
  const recoverable = display === "outcome_unknown" && active;
  return (
    <li className="rounded-lg bg-muted/60 px-2.5 py-2 ring-1 ring-border">
      <p className="flex items-center justify-between gap-2 text-[12px]">
        <span className="font-medium">Captions · {job.language.toUpperCase()}</span>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium ring-1", BADGE[display])}>
          {FILM_CAPTION_LABELS[display]}
        </span>
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        Cost: {job.costUsd !== undefined ? `$${job.costUsd.toFixed(2)} reported` : "unavailable"}
        {job.durationSeconds !== undefined && ` · ${job.durationSeconds}s`}
      </p>
      {job.error && display !== "outcome_unknown" && (
        <p role="alert" className="mt-1 break-words text-[11.5px] text-rose-600 dark:text-rose-300">{job.error}</p>
      )}
      {display === "outcome_unknown" && (
        <p role="status" className="mt-1.5 break-words text-[11.5px] font-medium leading-relaxed text-amber-700 dark:text-amber-300">
          {OUTCOME_UNKNOWN_COPY}
        </p>
      )}
      {job.status === "ready" && job.captionedUrl && (
        <details className="mt-1.5 rounded-md bg-background/50 px-2.5 py-2 ring-1 ring-border">
          <summary className="cursor-pointer text-[11.5px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            Show captioned result
          </summary>
          <div className="mt-2">
            <video src={job.captionedUrl} controls preload="metadata" className="aspect-video w-full rounded-lg bg-black" />
            <p className="mt-1 text-[10.5px] text-muted-foreground">
              Captioned derivative - saved as a linked receipt in Review. The original reel is unchanged.
            </p>
          </div>
        </details>
      )}
      {job.transcriptText && job.status !== "ready" && (
        <details className="mt-1.5 text-[11.5px]">
          <summary className="cursor-pointer font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            Received transcript (captions were not burned into a video)
          </summary>
          <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap leading-relaxed text-muted-foreground">
            {job.transcriptText}
          </p>
        </details>
      )}
      {job.status === "failed" && job.transcriptText && !job.providerJobId && (
        <p className="mt-1.5 text-[11.5px] text-muted-foreground">Repeating this same source would repeat the transcript-only result. Use Burn captions above to select a narrated video instead.</p>
      )}
      {job.transcriptText && job.status === "ready" && (
        <details className="mt-1.5 text-[11.5px]">
          <summary className="cursor-pointer font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            Transcript
          </summary>
          <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap leading-relaxed text-muted-foreground">
            {job.transcriptText}
          </p>
        </details>
      )}
      <div className="mt-1.5 flex flex-wrap gap-2">
        {retryable && (
          <Button variant="outline" onClick={onRetry} disabled={!allowed || busy !== null} className="rounded-full text-[11.5px]">
            {busy === `retry-${job.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden />}
            Retry captions
          </Button>
        )}
        {active && (
          <Button variant="outline" onClick={onCancel} disabled={!allowed || busy !== null} className="rounded-full text-[11.5px]">
            {busy === `cancel-${job.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
            Cancel captions
          </Button>
        )}
        {recoverable && (
          <Button variant="outline" onClick={onRecover} disabled={!allowed || busy !== null} className="rounded-full text-[11.5px]">
            {busy === `recover-${job.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden />}
            Start a new caption request
          </Button>
        )}
      </div>
    </li>
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
          Start a new caption request?
        </h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
          {RECOVERY_CONFIRM_COPY}
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
            {busy ? "Starting…" : "Start a new caption request"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CaptionConfirm({
  busy,
  narratedSources,
  targetDurationSeconds,
  onConfirm,
  onCancel
}: {
  busy: boolean;
  narratedSources: NonNullable<FilmRun["narrationJobs"]>;
  targetDurationSeconds: number;
  onConfirm: (language: string, narrationJobId?: string) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [language, setLanguage] = useState("");
  const [sourceId, setSourceId] = useState(narratedSources[0]?.id ?? "original");
  const [sourceDuration, setSourceDuration] = useState<number | null>(null);
  const selectedNarration = narratedSources.find((job) => job.id === sourceId);
  const sourceTooShort = !!selectedNarration && sourceDuration !== null && sourceDuration < targetDurationSeconds * 0.8;
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
          Burn captions into a copy?
        </h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
          This creates a separate derived video with burned-in captions. The original reel stays untouched.
          It submits a paid provider call - no pre-quote is available, the provider reports cost only after
          delivery, if at all.
        </p>
        <label className="mt-3 block">
          <span className="text-[12px] font-medium text-muted-foreground">Video to caption</span>
          <select value={sourceId} onChange={(event) => { setSourceId(event.target.value); setSourceDuration(null); }} aria-label="Video to caption" className="mt-1.5 w-full rounded-lg border border-border bg-card px-3 py-1.5 text-[13px]">
            <option value="original">Original reel (may be silent)</option>
            {narratedSources.map((job, index) => (
              <option key={job.id} value={job.id}>
                {index === 0 ? "Latest narrated copy" : "Older narrated copy"} · {formatNarrationDate(job.createdAt)}
              </option>
            ))}
          </select>
        </label>
        {selectedNarration?.narratedUrl && <video key={selectedNarration.id} src={selectedNarration.narratedUrl} preload="metadata" onLoadedMetadata={(event) => setSourceDuration(event.currentTarget.duration)} className="hidden" aria-hidden />}
        {sourceTooShort ? (
          <p role="alert" className="mt-1.5 text-[12px] text-rose-600 dark:text-rose-300">This narrated copy is only {sourceDuration?.toFixed(1)}s, shorter than the {targetDurationSeconds}s reel. Create a full-length narrated copy before burning captions.</p>
        ) : sourceId === "original" ? (
          <p className="mt-1.5 text-[12px] text-amber-700 dark:text-amber-300">Captions require speech in the selected video. A silent original reel may return a transcript but no captioned video.</p>
        ) : null}
        <label className="mt-3 block">
          <span className="text-[12px] font-medium text-muted-foreground">Caption language (required)</span>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            aria-label="Caption language"
            className="mt-1.5 w-full rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] focus:border-emerald-500/50 focus:outline-none"
          >
            <option value="">Select language…</option>
            {CAPTION_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label} ({l.code})</option>
            ))}
          </select>
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" ref={cancelRef} onClick={onCancel} disabled={busy} className="rounded-full">
            Keep as is
          </Button>
          <Button
            onClick={() => language && onConfirm(language, sourceId === "original" ? undefined : sourceId)}
            disabled={busy || !language || sourceTooShort || (!!selectedNarration && sourceDuration === null)}
            aria-busy={busy}
            title={!language ? "Choose a caption language first" : undefined}
            className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 disabled:opacity-50 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
          >
            {busy ? "Submitting…" : "Burn captions"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function formatNarrationDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "date unavailable";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}
