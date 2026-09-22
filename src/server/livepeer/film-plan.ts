import type { TemplateFormat } from "./template-catalogue";
import type { CampaignRequest } from "../types";

/**
 * Campaign Film planning (first half): durable local planning and user
 * confirmation only. Nothing here submits a Livepeer job, touches the DKG,
 * alters consent flows, or changes the short-clip runner or template
 * behavior - it only types, validates, and starts Film Plans that persist
 * as optional JSON on the campaign request (no migration; legacy rows
 * simply have no film plan).
 *
 * Product boundary (never imply otherwise): a "short clip" is exactly one
 * 3-15 second motion deliverable. A "campaign film" is several 3-15 second
 * scenes, assembled later into one longer reel. A 30/45/60-second coherent
 * video is never generated as a single inference call.
 */

export type FilmMode = "short_clip" | "campaign_film";

/** The only plannable film totals in this task. Anything else is rejected. */
export const FILM_TARGET_DURATIONS = [30, 45, 60] as const;
export type FilmTargetDuration = (typeof FILM_TARGET_DURATIONS)[number];

/**
 * Film aspects the provider surface accepts (observed submit_creative_job
 * enum). 4:5 is NOT supported for Campaign Film: plans requesting it are
 * rejected before persistence, never silently submitted without it. 4:5
 * stays fully available for short image/template flows.
 */
export const FILM_SUPPORTED_ASPECTS: TemplateFormat[] = ["9:16", "1:1", "16:9"];

export const FILM_MIN_SCENES = 2;
export const FILM_MAX_SCENES = 30;
/** Every scene is one short shot: whole 3-15 seconds, like any short clip. */
export const FILM_SCENE_MIN_SECONDS = 3;
export const FILM_SCENE_MAX_SECONDS = 15;

/** The only scene status in this task - generation has not started. */
export type FilmSceneStatus = "planned";

export type FilmFinishingKind = "narration" | "music" | "subtitles";
/** All finishing options are visibly unavailable in this task. */
export const FILM_FINISHING_UNAVAILABLE: FilmFinishingKind[] = ["narration", "music", "subtitles"];

export interface FilmScene {
  /** Stable id (starter plans use film-scene-1..n); unique within the plan. */
  id: string;
  /** 1-based position; must run 1..n in array order (stable ordering). */
  order: number;
  /** Whole 3-15 seconds - one short shot. */
  durationSeconds: number;
  /** Concise story beat, e.g. "Hook". */
  title: string;
  /** Shot-level visual direction for the scene. */
  visualDirection: string;
  /** What approved reference the scene leans on. */
  sourceIntent: string;
  /** Requested format for this scene's shot. */
  format: TemplateFormat;
  status: FilmSceneStatus;
}

export interface FilmPlan {
  mode: FilmMode;
  title: string;
  targetDurationSeconds: FilmTargetDuration;
  aspectRatio: TemplateFormat;
  /** Required total budget cap in USD for film mode. */
  budgetCapUsd: number;
  scenes: FilmScene[];
  /** Optional finishing requests; every option is unavailable in this task. */
  finishing?: { requested: FilmFinishingKind[] };
}

export type FilmPlanValidation = { ok: true; filmPlan: FilmPlan } | { ok: false; error: string };

const FILM_FORMATS: TemplateFormat[] = ["9:16", "4:5", "1:1", "16:9"];

function isFilmTarget(value: unknown): value is FilmTargetDuration {
  return typeof value === "number" && (FILM_TARGET_DURATIONS as readonly number[]).includes(value);
}

/**
 * Validate a raw film plan (pure). Rejects before persistence: bad mode or
 * target, missing title, missing/non-positive budget, scene count outside
 * 2-30, non-sequential ordering, non-whole or out-of-range scene lengths,
 * empty beat/direction/intent text, unknown formats, non-planned statuses,
 * totals that miss the target, and any finishing request (all unavailable).
 */
export function validateFilmPlan(raw: unknown): FilmPlanValidation {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "Film plan must be an object." };
  const v = raw as Record<string, unknown>;
  if (v.mode === "short_clip") {
    return { ok: false, error: "Short clips are planned with the 3–15 second picker - film planning saves campaign-film plans." };
  }
  if (v.mode !== "campaign_film") {
    return { ok: false, error: "Film plan mode must be short_clip or campaign_film." };
  }
  if (!isFilmTarget(v.targetDurationSeconds)) {
    return {
      ok: false,
      error: "Film target must be 30, 45, or 60 seconds - a reel is planned as separate short scenes, never one long render."
    };
  }
  const target = v.targetDurationSeconds;
  const title = typeof v.title === "string" ? v.title.trim() : "";
  if (!title) return { ok: false, error: "Give the film plan a title." };
  if (title.length > 120) return { ok: false, error: "Film title must be 120 characters or fewer." };
  if (typeof v.aspectRatio !== "string" || !FILM_FORMATS.includes(v.aspectRatio as TemplateFormat)) {
    return { ok: false, error: "Film aspect ratio must be one of 9:16, 4:5, 1:1, 16:9." };
  }
  const aspectRatio = v.aspectRatio as TemplateFormat;
  if (!FILM_SUPPORTED_ASPECTS.includes(aspectRatio)) {
    return {
      ok: false,
      error: "Campaign Film supports 9:16, 1:1, or 16:9 - the provider film surface has no 4:5 aspect, so a 4:5 film is never submitted. 4:5 stays available for short image packs."
    };
  }
  const budgetRaw = typeof v.budgetCapUsd === "string" ? Number(v.budgetCapUsd) : v.budgetCapUsd;
  if (budgetRaw === undefined || budgetRaw === null || (typeof budgetRaw === "string" && budgetRaw.trim() === "")) {
    return { ok: false, error: "A total budget cap in USD is required for campaign films." };
  }
  if (typeof budgetRaw !== "number" || !Number.isFinite(budgetRaw) || budgetRaw <= 0) {
    return { ok: false, error: "Budget cap must be a positive USD amount." };
  }
  const budgetCapUsd = Math.round(budgetRaw * 100) / 100;
  if (!Array.isArray(v.scenes)) return { ok: false, error: "Film plan needs an ordered scene list." };
  if (v.scenes.length < FILM_MIN_SCENES) {
    return { ok: false, error: "Campaign films need at least 2 planned scenes - one scene is a short clip, not a film." };
  }
  if (v.scenes.length > FILM_MAX_SCENES) {
    return { ok: false, error: `Campaign films hold at most ${FILM_MAX_SCENES} planned scenes - got ${v.scenes.length}.` };
  }
  const scenes: FilmScene[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < v.scenes.length; i += 1) {
    const s = v.scenes[i] as Record<string, unknown>;
    const label = typeof s?.title === "string" && s.title.trim() ? `"${String(s.title).trim()}"` : `scene ${i + 1}`;
    if (typeof s !== "object" || s === null) return { ok: false, error: `Scene ${i + 1} must be an object.` };
    const id = typeof s.id === "string" ? s.id.trim() : "";
    if (!id) return { ok: false, error: `Scene ${i + 1} needs a stable scene id.` };
    if (seenIds.has(id)) return { ok: false, error: `Scene id "${id}" appears more than once - scene ids must be stable and unique.` };
    seenIds.add(id);
    // Stable ordering: array position dictates playback; order must read 1..n.
    if (s.order !== i + 1) {
      return { ok: false, error: `Scene ${label} must carry order ${i + 1} - scene ordering is stable and sequential.` };
    }
    const duration = s.durationSeconds;
    if (typeof duration !== "number" || !Number.isFinite(duration) || !Number.isInteger(duration)) {
      return { ok: false, error: `Scene ${label}: duration must be a whole number of seconds (3–15).` };
    }
    if (duration < FILM_SCENE_MIN_SECONDS || duration > FILM_SCENE_MAX_SECONDS) {
      return { ok: false, error: `Scene ${label}: duration must be 3–15 seconds - one short shot, never a long render.` };
    }
    const beat = typeof s.title === "string" ? s.title.trim() : "";
    if (!beat) return { ok: false, error: `Scene ${i + 1} needs a concise story beat.` };
    if (beat.length > 120) return { ok: false, error: `Scene "${beat.slice(0, 40)}…": story beat must be 120 characters or fewer.` };
    const visualDirection = typeof s.visualDirection === "string" ? s.visualDirection.trim() : "";
    if (!visualDirection) return { ok: false, error: `Scene ${label} needs visual direction.` };
    const sourceIntent = typeof s.sourceIntent === "string" ? s.sourceIntent.trim() : "";
    if (!sourceIntent) return { ok: false, error: `Scene ${label} needs a source/reference intent.` };
    if (typeof s.format !== "string" || !FILM_FORMATS.includes(s.format as TemplateFormat)) {
      return { ok: false, error: `Scene ${label}: format must be one of 9:16, 4:5, 1:1, 16:9.` };
    }
    if (!FILM_SUPPORTED_ASPECTS.includes(s.format as TemplateFormat)) {
      return { ok: false, error: `Scene ${label}: 4:5 is not supported for Campaign Film - use 9:16, 1:1, or 16:9.` };
    }
    if (s.status !== "planned") {
      return { ok: false, error: `Scene ${label}: only "planned" scenes exist yet - generation has not started.` };
    }
    scenes.push({
      id,
      order: i + 1,
      durationSeconds: duration,
      title: beat,
      visualDirection,
      sourceIntent,
      format: s.format as TemplateFormat,
      status: "planned"
    });
  }
  const total = scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
  if (total !== target) {
    return {
      ok: false,
      error: `Scene durations total ${total}s but the film target is ${target}s - adjust scenes so the total matches exactly.`
    };
  }
  let finishing: { requested: FilmFinishingKind[] } | undefined;
  if (v.finishing !== undefined) {
    const f = v.finishing as Record<string, unknown>;
    if (typeof f !== "object" || f === null || !Array.isArray(f.requested)) {
      return { ok: false, error: "Finishing must look like { requested: [] }." };
    }
    if (f.requested.length > 0) {
      return { ok: false, error: "Audio finishing (narration, music, subtitles) is not available in this task." };
    }
    finishing = { requested: [] };
  }
  return {
    ok: true,
    filmPlan: {
      mode: "campaign_film",
      title,
      targetDurationSeconds: target,
      aspectRatio,
      budgetCapUsd,
      scenes,
      ...(finishing ? { finishing } : {})
    }
  };
}

interface StarterBeat {
  title: string;
  visualDirection: string;
}

const SOURCE_INTENT_DEFAULT = "Approved source media as the visual reference; no new claims introduced.";

const BEATS_6: StarterBeat[] = [
  { title: "Hook", visualDirection: "Close framing on the approved product in use; hold the full beat with no camera move." },
  { title: "Context", visualDirection: "Wide framing of the approved setting with the product visible in context." },
  { title: "Key benefit", visualDirection: "Medium framing on the key benefit moment; steady, well-lit product shot." },
  { title: "Proof · detail", visualDirection: "Macro-style detail framing of the product proof point; slow push-in." },
  { title: "Offer", visualDirection: "Clean studio-style framing of the product with space for the offer." },
  { title: "Call to action", visualDirection: "Hero framing of the product and brand moment; confident closing beat." }
];

const BEATS_8: StarterBeat[] = [
  { title: "Hook", visualDirection: "Close framing on the approved product in use; hold the full beat with no camera move." },
  { title: "Context", visualDirection: "Wide framing of the approved setting with the product visible in context." },
  { title: "Key benefit", visualDirection: "Medium framing on the key benefit moment; steady, well-lit product shot." },
  { title: "Benefit in use", visualDirection: "Over-the-shoulder style framing of the benefit in everyday use." },
  { title: "Proof · detail", visualDirection: "Macro-style detail framing of the product proof point; slow push-in." },
  { title: "Social proof", visualDirection: "Lifestyle framing suggesting real-world use; product clearly visible." },
  { title: "Offer", visualDirection: "Clean studio-style framing of the product with space for the offer." },
  { title: "Call to action", visualDirection: "Hero framing of the product and brand moment; confident closing beat." }
];

/** Deterministic starter scene durations per target (sum exactly). */
export const STARTER_SCENE_DURATIONS: Record<FilmTargetDuration, number[]> = {
  30: [5, 5, 5, 5, 5, 5],
  45: [8, 8, 8, 7, 7, 7],
  60: [8, 8, 8, 8, 7, 7, 7, 7]
};

/**
 * Deterministic starter scenes for a target: generic campaign beats
 * (Hook → Context → Key benefit → Proof/detail → CTA), stable ids,
 * sequential order, every scene 3-15s, totals exact. No LLM, no provider.
 */
export function createStarterScenes(target: FilmTargetDuration, aspect: TemplateFormat = "9:16"): FilmScene[] {
  const durations = STARTER_SCENE_DURATIONS[target];
  const beats = durations.length === 8 ? BEATS_8 : BEATS_6;
  return durations.map((durationSeconds, i) => ({
    id: `film-scene-${i + 1}`,
    order: i + 1,
    durationSeconds,
    title: beats[i].title,
    visualDirection: beats[i].visualDirection,
    sourceIntent: SOURCE_INTENT_DEFAULT,
    format: aspect,
    status: "planned" as const
  }));
}

/**
 * Deterministic starter film plan (title + budget supplied by the caller -
 * never invented). Passes validateFilmPlan by construction.
 */
export function createStarterFilmPlan(
  target: FilmTargetDuration,
  input: { title: string; budgetCapUsd: number; aspectRatio?: TemplateFormat }
): FilmPlanValidation {
  const aspectRatio = input.aspectRatio ?? "9:16";
  return validateFilmPlan({
    mode: "campaign_film",
    title: input.title,
    targetDurationSeconds: target,
    aspectRatio,
    budgetCapUsd: input.budgetCapUsd,
    scenes: createStarterScenes(target, aspectRatio)
  });
}

/**
 * Truthful plan summary for the UI. Names the total, the scene count, and
 * the separate-shots reality - never a single long render.
 */
export function describeFilmPlanSummary(plan: Pick<FilmPlan, "targetDurationSeconds" | "scenes">): string {
  const n = plan.scenes.length;
  return `${plan.targetDurationSeconds}-second campaign film · ${n} planned scene${n === 1 ? "" : "s"} · each scene renders as a separate short shot before final assembly.`;
}

/**
 * Legacy short-clip normalization for display: a persisted single-clip
 * length that is present but outside the whole 3-15s product range (e.g. a
 * 40-second legacy value) renders the exact legacy notice - never as an
 * available chip, never silently accepted. Returns null when the value is
 * absent or valid.
 */
export function describeLegacyShortClipSeconds(value: unknown): string | null {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n === "number" && Number.isInteger(n) && n >= 3 && n <= 15) return null;
  const label = typeof n === "number" && Number.isFinite(n) ? String(n) : String(value);
  return `Legacy setting: ${label}s is not supported for one short clip. Choose 3–15 seconds to update this plan.`;
}

/**
 * Pure persistence merge: the validated film plan lands on the campaign
 * request JSON next to the untouched template production spec - no
 * migration, no preflight rebuild, no job submission. Template apply,
 * produce, review, and proof paths never read this field, so short-clip
 * behavior is unchanged by construction.
 */
export function mergeFilmPlanIntoRequest(request: CampaignRequest, filmPlan: FilmPlan): CampaignRequest {
  return { ...request, filmPlan };
}
