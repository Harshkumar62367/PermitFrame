import { assertAudioDispatchable } from "./audio-contract";

/**
 * Narrated-reel finishing policy (pure): script validation, spoken-length
 * estimation, exact create_media request builders (tts + mux_audio only),
 * defensive response parsers, cap math, and interrupted-claim staleness.
 * No fetch, no DB, no side effects.
 *
 * Authority: src/server/livepeer/audio-contract.ts is the ONLY provider
 * contract source. Both builders send exactly the contract's required
 * fields plus the shared cost/idempotency fields - no model overrides,
 * styling, music, mixing, project ids, soundtrack fields, or voice
 * values (no exact accepted provider voice exists in the read-only
 * discovery data, so `voice` is omitted and the UI states provider
 * selection). Response shapes are unobserved (would require paid
 * dispatch), so every parse is defensive.
 */

export type FilmNarrationStatus =
  | "queued"
  | "generating_narration"
  | "waiting_for_narration"
  | "muxing"
  | "ready"
  | "failed"
  | "cancelled"
  | "outcome_unknown";

export const FILM_NARRATION_LABELS: Record<FilmNarrationStatus, string> = {
  queued: "Queued",
  generating_narration: "Generating narration",
  waiting_for_narration: "Waiting for narration",
  muxing: "Muxing",
  ready: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
  outcome_unknown: "Outcome unknown"
};

/**
 * PermitFrame product safeguard: narration scripts are bounded at 1,500
 * characters. This is OUR limit (abuse/cost control), not a provider
 * limit - never describe it as one, and never silently truncate.
 */
export const NARRATION_SCRIPT_MAX_CHARS = 1500;

/**
 * Documented conservative spoken rate: ~14 characters per second
 * (≈840 chars/min). Real conversational English runs 13-15 chars/sec;
 * 14 sits mid-range while ceil() rounds up, so estimates skew slightly
 * long - the safe direction for the reel-fit check. Actual delivery
 * varies by voice, language, and punctuation. Always labeled estimate.
 */
export const NARRATION_CHARS_PER_SECOND = 14;

/**
 * Stale-claim threshold: TTS p95 runs ~2 minutes and mux is an ffmpeg
 * pass, so a claimed phase with no outcome 30 minutes after dispatch
 * started is treated as outcome-unknown (possible interruption). Never
 * auto-resubmitted - only explicit user-confirmed recovery moves on.
 */
export const NARRATION_STALE_MS = 30 * 60 * 1000;

/** Rendered for stale claimed jobs: non-success, no outcome invented. */
export const NARRATION_OUTCOME_UNKNOWN_COPY =
  "Narration outcome unknown - PermitFrame did not record a result. The provider request may or may not have completed.";

/** Recovery confirmation: explicit consent to a possible second charge. */
export const NARRATION_RECOVERY_CONFIRM_COPY =
  "The prior narration request has no recorded outcome. Starting again may create another provider charge. The original reel will remain unchanged.";

/** Stable conflict message for a recovery that lost a concurrent change. */
export const NARRATION_RECOVERY_CONFLICT_MESSAGE =
  "This narration request was already recovered or changed. Refresh once to see its current status.";

export interface FilmNarrationJob {
  id: string;
  campaignId: string;
  filmRunId: string;
  /** Normalized script (workspace-private, like ProductionJob.prompt). Never copied to receipts/events/share. */
  script: string;
  scriptHash: string;
  /** Estimated spoken seconds at the documented conservative rate. */
  estimatedSeconds: number;
  /** Separate narration-finishing cap (USD maximum, never the film cap). */
  narrationCapUsd: number;
  /** The completed reel this derives from (never overwritten). */
  sourceReelUrl: string;
  status: FilmNarrationStatus;
  /** Async TTS provider job id, when one is returned. */
  ttsJobId?: string;
  /** Async mux provider job id, when one is returned. */
  muxJobId?: string;
  /** Verified HTTPS TTS audio URL - muxing waits for this, never assumes it. */
  narrationAudioUrl?: string;
  /** Per-phase idempotency keys (fresh per job; recovery mints new ones). */
  ttsIdempotencyKey: string;
  muxIdempotencyKey: string;
  ttsDispatchedAt?: string;
  muxDispatchedAt?: string;
  ttsCostUsd?: number;
  muxCostUsd?: number;
  actualCapability?: string;
  /** Linked narrated receipt id (set once, when a playable file lands). */
  receiptId?: string;
  /** Captioned output URL is never a narration input; narration audio URL is never an output claim. */
  narratedUrl?: string;
  error?: string;
  /** Client-generated key: repeats replay this job, never a second paid flow. */
  idempotencyKey?: string;
  dispatchStartedAt?: string;
  attempt: number;
  outcomeUnknownAt?: string;
  providerCancelConfirmed?: boolean;
  providerCancelNote?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface ScriptValidation {
  ok: true;
  script: string;
  estimatedSeconds: number;
}

export interface ScriptRejection {
  ok: false;
  error: string;
}

/**
 * Validate a narration script (pure): non-empty trimmed plain text,
 * normalized whitespace, no HTML/script tags, no control characters, and
 * the 1,500-character PermitFrame product safeguard. Never truncates.
 */
export function validateNarrationScript(value: unknown): ScriptValidation | ScriptRejection {
  const raw = typeof value === "string" ? value : "";
  const script = raw.replace(/\s+/g, " ").trim();
  if (!script) return { ok: false, error: "Write a narration script before continuing." };
  if (/<\/?[a-z][^>]*>/i.test(script) || /<script/i.test(script)) {
    return { ok: false, error: "Narration must be plain text - HTML and script tags are not accepted." };
  }
  // Control characters (BEL, backspace, C0/C1 controls, DEL) are never speech.
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(script)) {
    return { ok: false, error: "Narration contains control characters - remove them before continuing." };
  }
  if (script.length > NARRATION_SCRIPT_MAX_CHARS) {
    return {
      ok: false,
      error: `Narration is limited to ${NARRATION_SCRIPT_MAX_CHARS.toLocaleString()} characters as a PermitFrame product safeguard (not a provider limit) - shorten the script instead of truncating it.`
    };
  }
  return { ok: true, script, estimatedSeconds: estimateNarrationSeconds(script.length) };
}

/** Conservative spoken-length estimate in whole seconds (ceil - skews long). */
export function estimateNarrationSeconds(charCount: number): number {
  if (!Number.isFinite(charCount) || charCount <= 0) return 1;
  return Math.max(1, Math.ceil(charCount / NARRATION_CHARS_PER_SECOND));
}

/** Reel-fit gate: estimated narration must fit inside the reel duration. */
export function checkNarrationFitsReel(estimatedSeconds: number, reelSeconds: number): string | null {
  if (estimatedSeconds > reelSeconds) {
    return "This narration is likely longer than the reel. Shorten the script or create a longer Campaign Film first.";
  }
  return null;
}

/** Narration cap gate: positive USD maximum, required before confirmation. */
export function validateNarrationCap(value: unknown): { ok: true; capUsd: number } | { ok: false; error: string } {
  const n = typeof value === "string" ? Number(value) : value;
  if (n === undefined || n === null || (typeof n === "string" && (n as string).trim() === "")) {
    return { ok: false, error: "A maximum narration spend cap in USD is required before confirmation." };
  }
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    return { ok: false, error: "Narration cap must be a positive USD amount." };
  }
  return { ok: true, capUsd: Math.round(n * 100) / 100 };
}

/**
 * Mux budget gate: remaining = cap − known actual TTS cost. Unknown TTS
 * cost never counts as zero - without it no bounded mux request exists.
 */
export function narrationMuxBudget(
  capUsd: number,
  ttsCostUsd: number | undefined
): { ok: true; maxCostUsd: number } | { ok: false; error: string } {
  if (ttsCostUsd === undefined) {
    return {
      ok: false,
      error: "Actual narration cost was not reported - refusing an unbounded mux request. The original reel is intact."
    };
  }
  const remaining = Math.round((capUsd - ttsCostUsd) * 100) / 100;
  if (!(remaining > 0)) {
    return {
      ok: false,
      error: `Known narration cost $${ttsCostUsd.toFixed(2)} already meets the $${capUsd.toFixed(2)} maximum - no budget remains for muxing. The original reel is intact.`
    };
  }
  return { ok: true, maxCostUsd: remaining };
}

export interface TtsRequestArgs {
  action: "tts";
  prompt: string;
  async: true;
  session_id: string;
  idempotency_key: string;
  max_cost_usd: number;
}

export interface MuxRequestArgs {
  action: "mux_audio";
  source_url: string;
  audio_url: string;
  audio_fill: "none";
  async: true;
  session_id: string;
  idempotency_key: string;
  max_cost_usd: number;
}

/**
 * TTS request: exactly the contract's required fields plus shared
 * cost/idempotency fields. No voice (no exact verified accepted value in
 * discovery), no model overrides, no styling, no music/mixing/project
 * fields. Throws unless the audio contract gates tts_narration verified.
 */
export function buildTtsRequest(input: {
  script: string;
  sessionId: string;
  idempotencyKey: string;
  maxCostUsd: number;
}): TtsRequestArgs {
  assertAudioDispatchable("tts_narration");
  return {
    action: "tts",
    prompt: input.script,
    async: true,
    session_id: input.sessionId,
    idempotency_key: input.idempotencyKey,
    max_cost_usd: input.maxCostUsd
  };
}

/**
 * Mux request: exactly the contract's required fields plus shared
 * cost/idempotency fields. audio_fill is always "none" - narration never
 * loops. Throws unless the contract gates mux_audio verified.
 */
export function buildMuxRequest(input: {
  reelUrl: string;
  audioUrl: string;
  sessionId: string;
  idempotencyKey: string;
  maxCostUsd: number;
}): MuxRequestArgs {
  assertAudioDispatchable("mux_audio");
  return {
    action: "mux_audio",
    source_url: input.reelUrl,
    audio_url: input.audioUrl,
    audio_fill: "none",
    async: true,
    session_id: input.sessionId,
    idempotency_key: input.idempotencyKey,
    max_cost_usd: input.maxCostUsd
  };
}

export interface ProviderRefParsed {
  providerJobId?: string;
  outputUrl?: string;
  costUsd?: number;
  capability?: string;
  /** Measured media dimensions/duration when the provider reports them. */
  actualWidth?: number;
  actualHeight?: number;
  durationSeconds?: number;
  statusText: string;
  failed: boolean;
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

/** Sidecars, playlists, transcripts, and data blobs are never playable media. */
function isNonMediaUrl(url: string): boolean {
  return /\.(srt|vtt|ttml|txt|json|m3u8|mpd)(\?|$)/i.test(url);
}

/** Genuine audio-file suffixes for discovered (non-explicit) URLs. */
function isAudioFileUrl(url: string): boolean {
  return /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus|wma)(\?|$)/i.test(url);
}

/** Genuine video-file suffixes for discovered (non-explicit) URLs. */
function isVideoFileUrl(url: string): boolean {
  return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url);
}

function usableMediaUrl(value: unknown, exclude: Set<string>): string | undefined {
  if (!isHttpsUrl(value) || exclude.has(value) || isNonMediaUrl(value)) return undefined;
  return value;
}

/**
 * Explicit structured audio keys: usable HTTPS, not an excluded echo,
 * never a sidecar, and never a known video file. Extension-blind beyond
 * that on purpose - a signed provider URL may carry no suffix.
 */
function extractExplicitAudioUrl(payload: Record<string, unknown>, exclude: Set<string>): string | undefined {
  const s = structuredOf(payload);
  for (const candidate of [s.audio_url, s.audioUrl]) {
    if (typeof candidate !== "string" || !isHttpsUrl(candidate)) continue;
    if (exclude.has(candidate) || isNonMediaUrl(candidate) || isVideoFileUrl(candidate)) continue;
    return candidate;
  }
  return undefined;
}

/**
 * First usable HTTPS audio URL: explicit audio keys first, then generic
 * discovered URLs ONLY with an audio suffix. Source echoes, video files
 * (.mp4/.webm/.mov/.m4v), sidecars, playlists, transcripts, JSON, and
 * malformed URLs never qualify.
 */
function extractAudioUrl(payload: Record<string, unknown>, exclude: Set<string>): string | undefined {
  const explicit = extractExplicitAudioUrl(payload, exclude);
  if (explicit) return explicit;
  const haystack = `${contentText(payload)}\n${JSON.stringify(payload.result ?? {})}`;
  const urls = (haystack.match(/https?:\/\/[^"'\s)\\]+/g) ?? []).map((u) => u.replace(/[.,]+$/, ""));
  for (const u of urls) {
    if (!isAudioFileUrl(u)) continue;
    const usable = usableMediaUrl(u, exclude);
    if (usable) return usable;
  }
  return undefined;
}

/**
 * First usable HTTPS video URL: explicit video keys first, then generic
 * discovered URLs ONLY with a video suffix. Source/audio echoes,
 * sidecars, playlists, and transcripts never qualify.
 */
function extractVideoUrl(payload: Record<string, unknown>, exclude: Set<string>): string | undefined {
  const s = structuredOf(payload);
  for (const candidate of [s.video_url, s.output_url, s.url, s.muxed_url, s.muxedUrl]) {
    const usable = usableMediaUrl(candidate, exclude);
    if (usable) return usable;
  }
  const haystack = `${contentText(payload)}\n${JSON.stringify(payload.result ?? {})}`;
  const urls = (haystack.match(/https?:\/\/[^"'\s)\\]+/g) ?? []).map((u) => u.replace(/[.,]+$/, ""));
  for (const u of urls) {
    if (!isVideoFileUrl(u)) continue;
    const usable = usableMediaUrl(u, exclude);
    if (usable) return usable;
  }
  return undefined;
}

function extractRef(payload: Record<string, unknown>): { providerJobId?: string; costUsd?: number; capability?: string; statusText: string; failed: boolean } {
  const s = structuredOf(payload);
  const jobId =
    str(s.job_id ?? s.jobId) ??
    contentText(payload).match(/(?:job_id|jobId)["'\s:]+([A-Za-z0-9_-]+)/)?.[1];
  const statusText =
    (typeof s.status === "string" && s.status ? s.status : undefined) ??
    (typeof s.state === "string" && s.state ? s.state : undefined) ??
    "";
  const lowered = statusText.toLowerCase();
  return {
    ...(jobId ? { providerJobId: jobId } : {}),
    costUsd: num(s.cost_paid_usd ?? s.cost_usd_estimated ?? s.cost_usd ?? s.total_cost_usd),
    capability: str(s.capability ?? s.capability_used ?? s.model ?? s.model_used),
    statusText: lowered,
    failed: ["failed", "error", "cancelled", "canceled", "timeout", "timed_out"].includes(lowered)
  };
}

/** Defensive TTS parse: usable HTTPS audio only (source echoes excluded); echoes/sidecars/empties yield nothing. */
export function parseTtsResult(payload: Record<string, unknown>, excludeUrls: string[] = []): ProviderRefParsed {
  const raw = structuredOf(payload);
  const ref = extractRef(payload);
  const outputUrl = ref.failed ? undefined : extractAudioUrl(payload, new Set(excludeUrls));
  return { ...ref, ...(outputUrl ? { outputUrl } : {}), raw };
}

/**
 * Defensive mux parse: usable HTTPS video only, excluding the source reel
 * and the narration audio (an echo of either input is not a deliverable).
 */
export function parseMuxResult(payload: Record<string, unknown>, excludeUrls: string[]): ProviderRefParsed {
  const raw = structuredOf(payload);
  const ref = extractRef(payload);
  const outputUrl = ref.failed ? undefined : extractVideoUrl(payload, new Set(excludeUrls));
  const width = num(raw.width ?? raw.video_width ?? raw.w);
  const height = num(raw.height ?? raw.video_height ?? raw.h);
  const durationSeconds = num(raw.duration_seconds ?? raw.durationSeconds ?? raw.duration);
  return {
    ...ref,
    ...(outputUrl ? { outputUrl } : {}),
    ...(width !== undefined && width > 0 ? { actualWidth: width } : {}),
    ...(height !== undefined && height > 0 ? { actualHeight: height } : {}),
    ...(durationSeconds !== undefined && durationSeconds > 0 ? { durationSeconds } : {}),
    raw
  };
}

/** Provider status text safe for persisted messages: short slugs pass, anything else becomes a static label. */
export function safePhaseState(statusText: string): string {
  return /^[a-z0-9_ -]{1,40}$/.test(statusText) ? statusText : "provider-reported state";
}

/** Active narration work for progress display. */
export function isActiveNarrationStatus(status: FilmNarrationStatus): boolean {
  return status === "queued" || status === "generating_narration" || status === "waiting_for_narration" || status === "muxing";
}

/** Terminal narration states settle the job. */
export function isTerminalNarrationStatus(status: FilmNarrationStatus): boolean {
  return status === "ready" || status === "failed" || status === "cancelled" || status === "outcome_unknown";
}

/**
 * Interrupted-claim detection (pure, read-only), phase-aware: TTS phases
 * time out from the TTS dispatch claim, muxing from the mux dispatch
 * claim, so a long TTS run never makes a fresh mux look stale. The legacy
 * dispatchStartedAt is only a fallback for rows written before phase
 * timestamps existed - never the source of truth. Queued jobs never
 * claimed anything and are never stale. Phase timestamps are never reset.
 */
export function isNarrationStale(
  job: Pick<FilmNarrationJob, "status" | "ttsDispatchedAt" | "muxDispatchedAt" | "dispatchStartedAt">,
  nowMs: number = Date.now()
): boolean {
  const aged = (iso: string | undefined): boolean => {
    if (!iso) return false;
    const started = Date.parse(iso);
    if (!Number.isFinite(started)) return false;
    return nowMs - started > NARRATION_STALE_MS;
  };
  if (job.status === "generating_narration" || job.status === "waiting_for_narration") {
    return aged(job.ttsDispatchedAt ?? job.dispatchStartedAt);
  }
  if (job.status === "muxing") {
    return aged(job.muxDispatchedAt ?? job.dispatchStartedAt);
  }
  return false;
}

/** Display status (pure, never mutates): stale claimed jobs render outcome_unknown. */
export function narrationDisplayStatus(
  job: Pick<FilmNarrationJob, "status" | "ttsDispatchedAt" | "muxDispatchedAt" | "dispatchStartedAt">,
  nowMs: number = Date.now()
): FilmNarrationStatus {
  if (job.status === "outcome_unknown") return "outcome_unknown";
  if (isNarrationStale(job, nowMs)) return "outcome_unknown";
  return job.status;
}

/** Explicit-recovery eligibility (pure): only stale claimed jobs. */
export function narrationRecoveryError(
  job:
    | Pick<FilmNarrationJob, "status" | "ttsDispatchedAt" | "muxDispatchedAt" | "dispatchStartedAt">
    | undefined,
  nowMs: number = Date.now()
): string | null {
  if (!job) return "Narration job not found.";
  if (job.status === "outcome_unknown") {
    return "This narration request is already preserved as outcome-unknown - start a new request from the reel instead.";
  }
  if (!isNarrationStale(job, nowMs)) {
    return "Only narration requests with no recorded outcome past the stale window can use recovery - this job is still within its delivery window or already settled.";
  }
  return null;
}

/** Ordinary-retry eligibility (pure): explicitly failed with nothing tracked. */
export function canRetryNarrationJob(
  job: Pick<FilmNarrationJob, "status" | "ttsJobId" | "muxJobId"> | undefined
): string | null {
  if (!job) return "Narration job not found.";
  if (job.status !== "failed") return `Only failed narration jobs can resume - this job is ${job.status}.`;
  if (job.ttsJobId || job.muxJobId) {
    return "This job already reached the provider - resuming cannot recover it. Confirm a new narration request for a fresh provider flow.";
  }
  return null;
}
