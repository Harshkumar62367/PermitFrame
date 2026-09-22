import type { FilmPlan, FilmScene } from "./film-plan";
import type { TemplateFormat } from "./template-catalogue";

/**
 * Campaign Film provider wiring (pure): submit-argument builder and
 * defensive response parsers for the read-only-observed Creative MCP film
 * lifecycle (submit_creative_job / get_creative_job / cancel_creative_job).
 * No fetch, no DB, no side effects - fully unit-testable with synthetic
 * shapes. Observed 2026-09-22 via tools/list only (no paid calls):
 *
 * - submit_creative_job: "Render a multi-scene project — returns a job_id
 *   immediately and renders server-side over a few minutes. Poll
 *   get_creative_job for per-scene progress and the final viewer URL."
 *   The cost-confirm gate may STAGE the job (estimate >= $0.50 or >= 8
 *   scenes) instead of dispatching: execute mode is job_id + confirm:true.
 *   budget_usd is a hard ceiling checked before anything is staged or
 *   dispatched; over-cap plans are REFUSED with code 'budget_exceeded'
 *   (no silent trimming). deliver:'reel' stitches one file and returns
 *   `reel_url` ("Best-effort: a finishing failure still delivers the
 *   scenes and warns").
 * - get_creative_job: required job_id (^cjob_[a-z0-9]{6,32}$); "Returns
 *   per-scene status, URLs as they land, and the final viewer URL once
 *   everything's done." Free, sub-second.
 * - cancel_creative_job: required job_id; "Stop the worker from picking up
 *   new scenes... Already-dispatched renders complete naturally."
 *
 * Submit responses were never observed (that would spend), so every parse
 * below is defensive: unknown shapes fail honestly, never guessed.
 */

export interface CreativeSceneArg {
  title: string;
  prompt: string;
  duration: number;
}

export interface CreativeSubmitArgs {
  title: string;
  scenes: CreativeSceneArg[];
  target_duration_sec: number;
  /** Omitted when the confirmed aspect has no provider enum value (4:5). */
  aspect_ratio?: string;
  deliver: "reel";
  budget_usd: number;
  session_id: string;
}

/** Provider aspect values from the observed submit_creative_job schema. */
const PROVIDER_ASPECTS = ["1:1", "16:9", "9:16", "2.35:1", "3:2", "2:3", "4:3", "3:4"];

/** Scene prompt ceiling: the observed per-scene prompt limit is 4000 chars. */
export const SCENE_PROMPT_MAX_CHARS = 4000;

/**
 * Deterministic provider scene prompt from the confirmed scene: beat +
 * visual direction + source intent. Text only - no reference image is ever
 * attached, so no identity preservation is claimed downstream.
 */
export function buildScenePrompt(scene: Pick<FilmScene, "title" | "visualDirection" | "sourceIntent">): string {
  const base = `${scene.title}: ${scene.visualDirection} Reference: ${scene.sourceIntent}`;
  if (base.length <= SCENE_PROMPT_MAX_CHARS) return base;
  const head = `${scene.title}: `;
  const tail = ` Reference: ${scene.sourceIntent}`;
  const room = SCENE_PROMPT_MAX_CHARS - head.length - tail.length;
  return `${head}${scene.visualDirection.slice(0, Math.max(0, room))}${tail}`;
}

/**
 * Submit arguments from the confirmed plan: exactly the product-required
 * fields (title, scenes, target_duration_sec, aspect_ratio, deliver reel,
 * budget_usd) plus the stable per-run session tag. Deliberately absent:
 * auto_plan (we pass explicit scenes), generation_mode (undocumented for
 * this product - provider auto-fallback applies), quality/style/brief
 * (unconfirmed), character_anchor/cast (no reference image leaves us),
 * checkpoint/keyframe gates, and any audio/finishing fields.
 */
export function buildCreativeSubmitArgs(
  plan: Pick<FilmPlan, "title" | "targetDurationSeconds" | "aspectRatio" | "budgetCapUsd" | "scenes">,
  sessionId: string
): CreativeSubmitArgs {
  return {
    title: plan.title,
    scenes: plan.scenes.map((s) => ({
      title: s.title,
      prompt: buildScenePrompt(s),
      duration: s.durationSeconds
    })),
    target_duration_sec: plan.targetDurationSeconds,
    ...(PROVIDER_ASPECTS.includes(plan.aspectRatio) ? { aspect_ratio: plan.aspectRatio } : {}),
    deliver: "reel",
    budget_usd: plan.budgetCapUsd,
    session_id: sessionId
  };
}

/** Execute-mode arguments: approve a staged job. Only sent after the user confirmed the plan + cap. */
export function buildCreativeConfirmArgs(providerJobId: string): { job_id: string; confirm: true } {
  return { job_id: providerJobId, confirm: true };
}

export interface CreativeSubmitParsed {
  /** Non-empty provider id is tracked, never treated as completion. */
  providerJobId?: string;
  /** Cost-confirm gate staged the job: approve via job_id + confirm:true. */
  awaitingConfirmation: boolean;
  estimateUsd?: number;
  budgetUsd?: number;
  budgetRemainingUsd?: number;
  /** Over-cap refusal: nothing staged, nothing dispatched. */
  budgetExceeded?: { estimateUsd?: number; budgetUsd?: number; note: string };
  raw: Record<string, unknown>;
}

export interface CreativeSceneOutputParsed {
  index: number;
  title?: string;
  url: string;
  status?: string;
}

export interface CreativeStatusParsed {
  statusText: string;
  /** Non-terminal gate state: the job waits for job_id + confirm:true. */
  awaitingConfirmation: boolean;
  terminal: boolean;
  failed: boolean;
  providerJobId?: string;
  /** Final reel file URL (HTTPS-verified by the caller, never here). */
  reelUrl?: string;
  /** Provider-reported per-scene outputs (HTTPS-verified entries only). */
  sceneOutputs: CreativeSceneOutputParsed[];
  costUsd?: number;
  estimateUsd?: number;
  capability?: string;
  raw: Record<string, unknown>;
}

const TERMINAL_STATES = [
  "completed", "complete", "succeeded", "success", "delivered", "done",
  "failed", "cancelled", "canceled", "error", "timeout", "timed_out"
];
const FAILED_STATES = ["failed", "cancelled", "canceled", "error", "timeout", "timed_out"];

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

/** Non-empty provider job id from structured fields, then loose text. */
export function extractCreativeJobId(payload: Record<string, unknown>): string | undefined {
  const s = structuredOf(payload);
  for (const candidate of [s.job_id, s.jobId, s.id]) {
    const id = str(candidate);
    if (id) return id;
  }
  const match = contentText(payload).match(/(?:job_id|jobId)["'\s:]+([A-Za-z0-9_-]+)/);
  return match?.[1];
}

function extractCreativeStatus(payload: Record<string, unknown>): string {
  const s = structuredOf(payload);
  for (const candidate of [s.status, s.state, s.phase]) {
    if (typeof candidate === "string" && candidate) return candidate.toLowerCase();
  }
  return contentText(payload).match(/status["'\s:]+([A-Za-z_-]+)/i)?.[1]?.toLowerCase() ?? "";
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("https://")) return false;
  try {
    const parsed = new URL(value);
    return parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Reel URL preference: the observed schema names `reel_url` for the
 * stitched deliverable. Viewer/page URLs are not completion - only an
 * explicit reel/output file URL counts (HTTPS-verified by the caller).
 */
function extractReelUrl(payload: Record<string, unknown>): string | undefined {
  const s = structuredOf(payload);
  for (const candidate of [s.reel_url, s.reelUrl, s.final_url, s.finalUrl, s.output_url, s.video_url]) {
    if (isHttpsUrl(candidate)) return candidate;
  }
  return undefined;
}

/** Provider-reported per-scene outputs: HTTPS entries only, index-stable. */
function extractSceneOutputs(payload: Record<string, unknown>): CreativeSceneOutputParsed[] {
  const s = structuredOf(payload);
  const scenes = Array.isArray(s.scenes) ? s.scenes : Array.isArray(s.scene_statuses) ? s.scene_statuses : [];
  const out: CreativeSceneOutputParsed[] = [];
  scenes.forEach((entry, i) => {
    if (!isRecord(entry)) return;
    const url = [entry.url, entry.video_url, entry.output_url, entry.reel_url].find(isHttpsUrl);
    if (!url) return;
    out.push({
      index: typeof entry.index === "number" ? entry.index : i,
      ...(str(entry.title ?? entry.name) ? { title: str(entry.title ?? entry.name) as string } : {}),
      url,
      ...(str(entry.status ?? entry.state) ? { status: str(entry.status ?? entry.state) as string } : {})
    });
  });
  return out;
}

function extractCost(payload: Record<string, unknown>): number | undefined {
  const s = structuredOf(payload);
  return (
    num(s.cost_paid_usd) ?? num(s.cost_usd_estimated) ?? num(s.cost_usd) ?? num(s.total_cost_usd) ?? undefined
  );
}

function extractCapability(payload: Record<string, unknown>): string | undefined {
  const s = structuredOf(payload);
  return str(s.capability ?? s.capability_used ?? s.model ?? s.model_used);
}

function detectBudgetExceeded(payload: Record<string, unknown>): { estimateUsd?: number; budgetUsd?: number; note: string } | undefined {
  const s = structuredOf(payload);
  const code = str(s.code ?? (isRecord(s.error) ? s.error.code : undefined));
  const haystack = `${code ?? ""}\n${contentText(payload)}`.toLowerCase();
  if (code === "budget_exceeded" || haystack.includes("budget_exceeded")) {
    return {
      estimateUsd: num(s.estimate_usd ?? s.estimateUsd),
      budgetUsd: num(s.budget_usd ?? s.budgetUsd),
      note: contentText(payload).slice(0, 400) || "Provider refused: plan estimate exceeds the budget ceiling."
    };
  }
  return undefined;
}

function isAwaitingConfirmation(statusText: string, payload: Record<string, unknown>): boolean {
  if (/(awaiting_confirmation|awaiting confirmation|needs_confirmation|needs confirmation|\bstaged\b)/.test(statusText)) return true;
  const s = structuredOf(payload);
  return s.requires_confirmation === true || s.awaiting_confirmation === true;
}

/** Defensive submit parse: staged, refused, and id-carrying shapes all handled; unknowns fail honestly. */
export function parseCreativeSubmit(payload: Record<string, unknown>): CreativeSubmitParsed {
  const raw = structuredOf(payload);
  const budgetExceeded = detectBudgetExceeded(payload);
  const statusText = extractCreativeStatus(payload);
  return {
    ...(extractCreativeJobId(payload) ? { providerJobId: extractCreativeJobId(payload) as string } : {}),
    awaitingConfirmation: isAwaitingConfirmation(statusText, payload),
    estimateUsd: num(raw.estimate_usd ?? raw.estimateUsd),
    budgetUsd: num(raw.budget_usd ?? raw.budgetUsd),
    budgetRemainingUsd: num(raw.budget_remaining_usd ?? raw.budgetRemainingUsd),
    ...(budgetExceeded ? { budgetExceeded } : {}),
    raw
  };
}

/** Defensive status parse: terminal/failed derived from status text; reel + scenes extracted HTTPS-only. */
export function parseCreativeStatus(payload: Record<string, unknown>): CreativeStatusParsed {
  const raw = structuredOf(payload);
  const statusText = extractCreativeStatus(payload);
  return {
    statusText,
    awaitingConfirmation: isAwaitingConfirmation(statusText, payload),
    terminal: TERMINAL_STATES.includes(statusText),
    failed: FAILED_STATES.includes(statusText),
    ...(extractCreativeJobId(payload) ? { providerJobId: extractCreativeJobId(payload) as string } : {}),
    ...(extractReelUrl(payload) ? { reelUrl: extractReelUrl(payload) as string } : {}),
    sceneOutputs: extractSceneOutputs(payload),
    costUsd: extractCost(payload),
    estimateUsd: num(raw.estimate_usd ?? raw.estimateUsd),
    capability: extractCapability(payload),
    raw
  };
}

/** Stable fingerprint of the confirmed scene plan (shape + order + lengths). */
export function filmSceneFingerprint(
  scenes: Pick<FilmScene, "id" | "order" | "durationSeconds" | "title" | "visualDirection" | "sourceIntent" | "format">[],
  hash: (value: string) => string
): string {
  const canonical = scenes.map((s) => ({
    id: s.id,
    order: s.order,
    durationSeconds: s.durationSeconds,
    title: s.title,
    visualDirection: s.visualDirection,
    sourceIntent: s.sourceIntent,
    format: s.format
  }));
  return hash(JSON.stringify(canonical));
}

/** Aspect values with no provider enum entry are omitted from submit (never mapped to a lookalike). */
export function filmAspectForProvider(aspect: TemplateFormat): string | undefined {
  return PROVIDER_ASPECTS.includes(aspect) ? aspect : undefined;
}
