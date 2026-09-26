/**
 * Burn-captions finishing for completed Campaign Film reels (pure). Uses
 * ONLY the read-only-observed `transcribe` MCP tool - no TTS, music,
 * mixing, muxing, lipsync, or other dispatch. Observed 2026-09-23 via
 * tools/list only (no paid calls):
 *
 * - transcribe: "Runs ASR (wizper) and returns the transcript text + timed
 *   SRT + cues. Set burn:true to also burn the captions onto the video
 *   (ffmpeg-burn-subtitles) and get a captioned video URL back."
 * - Required: source_url (public https video/audio). Optional: burn
 *   (default false → transcript + SRT only), language (ISO hint, omit =
 *   auto-detect), granularity (word|segment), vocabulary (brand-name ASR
 *   bias), font_size (12-72), font_color, outline (0-6), caption_position
 *   (top|bottom). No budget/cost field, no idempotency key, no async job
 *   verbs - one synchronous call.
 *
 * What we send (and why): source_url (the confirmed reel), burn:true
 * (only after explicit user confirmation), language (always - the UI
 * requires an explicit choice, never auto-detect). Deliberately absent:
 * granularity, vocabulary, and all font styling (the UI collects none -
 * provider defaults apply), plus anything audio-related.
 *
 * No pre-quote exists: the tool reports cost only after delivery, if at
 * all. Receipts costUsd stays undefined ("unavailable") until then.
 */

export type FilmCaptionStatus =
  | "queued"
  | "transcribing"
  | "burning"
  | "ready"
  | "failed"
  | "cancelled"
  | "outcome_unknown";

export const FILM_CAPTION_LABELS: Record<FilmCaptionStatus, string> = {
  queued: "Queued",
  transcribing: "Transcribing",
  burning: "Burning captions",
  ready: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
  outcome_unknown: "Outcome unknown"
};

/**
 * Stale-claim threshold: the transcribe call times out at 10 minutes, so
 * a queued/transcribing/burning job still holding a dispatch claim 12 minutes
 * later is treated as outcome-unknown (interrupted, possibly delivered).
 * Never auto-resubmitted - only explicit user-confirmed recovery moves on.
 */
export const CAPTION_STALE_MS = 12 * 60 * 1000;

/** Rendered for stale claimed jobs: non-success, no outcome invented. */
export const OUTCOME_UNKNOWN_COPY =
  "Caption outcome unknown - PermitFrame did not record a result. The provider request may or may not have completed.";

/** Recovery confirmation: explicit consent to a possible second charge. */
export const RECOVERY_CONFIRM_COPY =
  "The prior caption request has no recorded outcome. Starting again may create another provider charge. The original reel will remain unchanged.";

/** Stable conflict message for a recovery that lost a concurrent change. */
export const RECOVERY_CONFLICT_MESSAGE =
  "This caption request was already recovered or changed. Refresh once to see its current status.";

/** ISO 639-ish hint the UI requires (schema examples: 'en', 'es'). */
export const CAPTION_LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Z]{2})?$/;

export const CAPTION_LANGUAGES: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "el", label: "Greek" }
];

/** Transcript metadata ceiling (SRT for a 60s reel is small; cap anyway). */
export const TRANSCRIPT_MAX_CHARS = 20000;

export interface FilmCaptionJob {
  id: string;
  campaignId: string;
  filmRunId: string;
  /** User-chosen ISO language - always explicit, never auto-detect. */
  language: string;
  /** The confirmed reel this derives from (never overwritten). */
  sourceReelUrl: string;
  status: FilmCaptionStatus;
  /** Owned provider job reference, when one is returned. */
  providerJobId?: string;
  /** Captioned video file URL - HTTPS-verified before ready, never otherwise. */
  captionedUrl?: string;
  /** Transcript text as metadata (also stored when no video is burned). */
  transcriptText?: string;
  costUsd?: number;
  durationSeconds?: number;
  actualWidth?: number;
  actualHeight?: number;
  error?: string;
  /** Client-generated key: repeats replay this job, never a second paid call. */
  idempotencyKey?: string;
  /**
   * Dispatch claim: set when the job moves queued → transcribing, before
   * the provider call. A claimed job with no outcome past CAPTION_STALE_MS
   * is outcome-unknown (possible interruption) - never auto-resubmitted.
   */
  dispatchStartedAt?: string;
  /** Dispatch attempts on this record (recovery mints a fresh record). */
  attempt: number;
  /** When explicit recovery preserved this record as outcome-unknown. */
  outcomeUnknownAt?: string;
  providerCancelConfirmed?: boolean;
  providerCancelNote?: string;
  /** Linked derived receipt id (set once, when a playable file lands). */
  receiptId?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface TranscribeArgs {
  source_url: string;
  burn: true;
  language: string;
}

/** Only the confirmed fields: reel URL, burn-after-confirmation, explicit language. */
export function buildTranscribeArgs(sourceReelUrl: string, language: string): TranscribeArgs {
  return { source_url: sourceReelUrl, burn: true, language };
}

/** Language gate: explicit ISO choice required before any provider action. */
export function validateCaptionLanguage(value: unknown): { ok: true; language: string } | { ok: false; error: string } {
  const language = typeof value === "string" ? value.trim() : "";
  if (!language) return { ok: false, error: "Choose a caption language before continuing." };
  if (language.length > 10 || !CAPTION_LANGUAGE_PATTERN.test(language)) {
    return { ok: false, error: "Caption language must be an ISO code such as en, es, or fr." };
  }
  return { ok: true, language };
}

export interface TranscribeParsed {
  /** Playable captioned video URL (HTTPS-verified candidates only). */
  outputUrl?: string;
  transcriptText?: string;
  providerJobId?: string;
  /** Burn-phase signal without a file yet (defensive - unobserved shape). */
  burnPending: boolean;
  failed: boolean;
  statusText: string;
  costUsd?: number;
  durationSeconds?: number;
  actualWidth?: number;
  actualHeight?: number;
  capability?: string;
  raw: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function structuredOf(payload: Record<string, unknown>): Record<string, unknown> {
  const result = payload.result as Record<string, unknown> | undefined;
  if (!isRecord(result)) return payload;
  const structured = result.structuredContent;
  return isRecord(structured) ? structured : result;
}

function contentText(payload: Record<string, unknown>): string {
  const result = payload.result as { content?: Array<{ text?: string }> } | undefined;
  if (!Array.isArray(result?.content)) return "";
  return result.content.map((item) => item.text).filter(Boolean).join("\n");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("https://")) return false;
  try {
    return new URL(value).hostname.length > 0;
  } catch {
    return false;
  }
}

/** Sidecar/playlist URLs are never playable captioned video. */
function isSidecarUrl(url: string): boolean {
  return /\.(srt|vtt|ttml|txt|json|m3u8)(\?|$)/i.test(url);
}

/**
 * Captioned-file candidates in trust order: explicit burn/caption keys
 * first, then generic media URLs. The request source URL (echoed back by
 * some surfaces) and sidecars never qualify.
 */
function extractCaptionedUrl(payload: Record<string, unknown>, sourceUrl: string): string | undefined {
  const s = structuredOf(payload);
  const excluded = new Set(
    [sourceUrl, s.source_url, s.sourceUrl].filter((v): v is string => typeof v === "string")
  );
  const usable = (url: unknown): url is string =>
    isHttpsUrl(url) && !excluded.has(url) && !isSidecarUrl(url);
  for (const candidate of [s.captioned_url, s.captionedUrl, s.burned_url, s.burnedUrl, s.video_url, s.output_url, s.url]) {
    if (usable(candidate)) return candidate;
  }
  const haystack = `${contentText(payload)}\n${JSON.stringify(payload.result ?? {})}`;
  const urls = (haystack.match(/https?:\/\/[^"'\s)\\]+/g) ?? []).map((u) => u.replace(/[.,]+$/, "")).filter(usable);
  const media = urls.filter((u) => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(u));
  return media[0] ?? urls[0];
}

function extractTranscript(payload: Record<string, unknown>): string | undefined {
  const s = structuredOf(payload);
  for (const candidate of [s.transcript, s.transcript_text, s.text, s.srt]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      const text = candidate.trim();
      return text.length > TRANSCRIPT_MAX_CHARS ? `${text.slice(0, TRANSCRIPT_MAX_CHARS)}… [truncated]` : text;
    }
  }
  return undefined;
}

/**
 * Defensive transcribe parse (response shapes unobserved - burn calls
 * would spend). Unknown shapes yield no output and no transcript, never
 * guesses; callers fail honestly.
 */
export function parseTranscribeResult(payload: Record<string, unknown>, sourceUrl: string): TranscribeParsed {
  const raw = structuredOf(payload);
  const statusText =
    (typeof raw.status === "string" && raw.status ? raw.status : undefined) ??
    (typeof raw.state === "string" && raw.state ? raw.state : undefined) ??
    "";
  const lowered = statusText.toLowerCase();
  const failed = ["failed", "error", "cancelled", "canceled", "timeout", "timed_out"].includes(lowered);
  const outputUrl = failed ? undefined : extractCaptionedUrl(payload, sourceUrl);
  const transcriptText = extractTranscript(payload);
  const jobId =
    str(raw.job_id ?? raw.jobId) ??
    contentText(payload).match(/(?:job_id|jobId)["'\s:]+([A-Za-z0-9_-]+)/)?.[1];
  const width = num(raw.width ?? raw.video_width ?? raw.w);
  const height = num(raw.height ?? raw.video_height ?? raw.h);
  return {
    ...(outputUrl ? { outputUrl } : {}),
    ...(transcriptText ? { transcriptText } : {}),
    ...(jobId ? { providerJobId: jobId } : {}),
    burnPending: !failed && !outputUrl && (/burn/.test(lowered) || (transcriptText !== undefined && jobId !== undefined)),
    failed,
    statusText: lowered,
    costUsd: num(raw.cost_paid_usd ?? raw.cost_usd_estimated ?? raw.cost_usd ?? raw.total_cost_usd),
    durationSeconds: num(raw.duration_seconds ?? raw.durationSeconds ?? raw.duration),
    ...(width !== undefined && width > 0 ? { actualWidth: width } : {}),
    ...(height !== undefined && height > 0 ? { actualHeight: height } : {}),
    capability: str(raw.capability ?? raw.capability_used ?? raw.model ?? raw.model_used),
    raw
  };
}

/** Active caption work (billable-or-pending) for progress display. */
export function isActiveCaptionStatus(status: FilmCaptionStatus): boolean {
  return status === "queued" || status === "transcribing" || status === "burning";
}

/** Terminal caption states settle the job. */
export function isTerminalCaptionStatus(status: FilmCaptionStatus): boolean {
  return status === "ready" || status === "failed" || status === "cancelled" || status === "outcome_unknown";
}

/**
 * Interrupted-claim detection (pure, read-only): a queued/transcribing/burning job
 * holding a dispatch claim older than CAPTION_STALE_MS may have been cut
 * off mid-call by a restart - its outcome is unknown. Queued jobs that
 * never claimed (no dispatchStartedAt) are ordinary pending work. A
 * burn-pending response has no supported status lookup, so it cannot
 * remain active forever.
 */
export function isCaptionStale(
  job: Pick<FilmCaptionJob, "status" | "dispatchStartedAt">,
  nowMs: number = Date.now()
): boolean {
  if (job.status !== "queued" && job.status !== "transcribing" && job.status !== "burning") return false;
  if (!job.dispatchStartedAt) return false;
  const started = Date.parse(job.dispatchStartedAt);
  if (!Number.isFinite(started)) return false;
  return nowMs - started > CAPTION_STALE_MS;
}

/**
 * Display status (pure, never mutates): stale claimed jobs render as
 * outcome_unknown - a clear non-success state - while the stored record
 * keeps its last known state until explicit recovery preserves it.
 */
export function captionDisplayStatus(
  job: Pick<FilmCaptionJob, "status" | "dispatchStartedAt">,
  nowMs: number = Date.now()
): FilmCaptionStatus {
  if (job.status === "outcome_unknown") return "outcome_unknown";
  if (isCaptionStale(job, nowMs)) return "outcome_unknown";
  return job.status;
}

/**
 * Explicit-recovery eligibility (pure): only stale claimed jobs. Failed
 * jobs use ordinary retry, burning jobs hold a tracked provider id, and
 * settled jobs are terminal - none of them qualify.
 */
export function captionRecoveryError(
  job: Pick<FilmCaptionJob, "status" | "dispatchStartedAt" | "providerJobId"> | undefined,
  nowMs: number = Date.now()
): string | null {
  if (!job) return "Caption job not found.";
  if (job.status === "outcome_unknown") return "This caption request is already preserved as outcome-unknown - start a new request from the reel instead.";
  if (!isCaptionStale(job, nowMs)) {
    return "Only caption requests with no recorded outcome past the stale window can use recovery - this job is still within its delivery window or already settled.";
  }
  return null;
}

/** Ordinary-retry eligibility (pure): explicitly failed with nothing tracked. */
export function canRetryCaptionJob(
  job: Pick<FilmCaptionJob, "status" | "providerJobId"> | undefined
): string | null {
  if (!job) return "Caption job not found.";
  if (job.status !== "failed") return `Only failed caption jobs can resume - this job is ${job.status}.`;
  if (job.providerJobId) {
    return "This job already reached the provider - resuming cannot recover it. Confirm a new burn-captions job for a fresh provider call.";
  }
  return null;
}
