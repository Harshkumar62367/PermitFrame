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
/**
 * Finishing kinds the film-plan submission payload cannot carry. This is
 * about the plan payload only - narration and burned captions remain
 * explicit post-delivery actions on a delivered reel, while music and
 * soundtrack mixing are not available yet.
 */
export const FILM_PLAN_UNSUPPORTED_FINISHING: FilmFinishingKind[] = ["narration", "music", "subtitles"];

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
  /**
   * Optional finishing requests; never submitted - the persisted plan
   * payload carries no actionable finishing request. Non-empty requests are rejected with an
   * honest redirect (post-delivery actions or not-available-yet).
   */
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
 * totals that miss the target, and any finishing request (narration belongs
 * to post-delivery; music/subtitles are not plan-submittable).
 */
export function validateFilmPlan(raw: unknown): FilmPlanValidation {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "Film plan must be an object." };
  const v = raw as Record<string, unknown>;
  if (v.mode === "short_clip") {
    return { ok: false, error: "Short clips are planned with the 3-15 second picker - film planning saves campaign-film plans." };
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
      return { ok: false, error: `Scene ${label}: duration must be a whole number of seconds (3-15).` };
    }
    if (duration < FILM_SCENE_MIN_SECONDS || duration > FILM_SCENE_MAX_SECONDS) {
      return { ok: false, error: `Scene ${label}: duration must be 3-15 seconds - one short shot, never a long render.` };
    }
    const beat = typeof s.title === "string" ? s.title.trim() : "";
    if (!beat) return { ok: false, error: `Scene ${i + 1} needs a concise story beat.` };
    if (beat.length > 120) return { ok: false, error: `Scene "${beat.slice(0, 40)}…": story beat must be 120 characters or fewer.` };
    const visualDirection = typeof s.visualDirection === "string" ? s.visualDirection.trim() : "";
    if (!visualDirection) return { ok: false, error: `Scene ${label} needs visual direction.` };
    const sourceIntent = typeof s.sourceIntent === "string" ? s.sourceIntent.trim() : "";
    if (!sourceIntent) return { ok: false, error: `Scene ${label} needs a source/reference intent.` };
    // One aspect ratio per Campaign Film: the plan-level aspect is the only
    // value the provider ever receives. A missing scene format is a legacy
    // draft - normalize it to the plan aspect. An explicitly mismatched
    // format is rejected rather than silently submitted as the plan aspect.
    const rawFormat = typeof s.format === "string" ? s.format : "";
    const sceneFormat: TemplateFormat = (rawFormat === "" ? aspectRatio : rawFormat) as TemplateFormat;
    if (rawFormat !== "" && !FILM_FORMATS.includes(sceneFormat)) {
      return { ok: false, error: `Scene ${label}: format must be one of 9:16, 4:5, 1:1, 16:9.` };
    }
    if (!FILM_SUPPORTED_ASPECTS.includes(sceneFormat)) {
      return { ok: false, error: `Scene ${label}: 4:5 is not supported for Campaign Film - use 9:16, 1:1, or 16:9.` };
    }
    if (sceneFormat !== aspectRatio) {
      return {
        ok: false,
        error: `Scene ${label}: aspect ${sceneFormat} does not match the film aspect ${aspectRatio} - one aspect ratio per Campaign Film; scenes follow the plan-level aspect.`
      };
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
      format: sceneFormat,
      status: "planned"
    });
  }
  const total = scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
  if (total !== target) {
    return { ok: false, error: describeFilmDurationMismatch(total, target) };
  }
  let finishing: { requested: FilmFinishingKind[] } | undefined;
  if (v.finishing !== undefined) {
    const f = v.finishing as Record<string, unknown>;
    if (typeof f !== "object" || f === null || !Array.isArray(f.requested)) {
      return { ok: false, error: "Finishing must look like { requested: [] }." };
    }
    if (f.requested.length > 0) {
      // Narration is a post-delivery action (script + separate spend cap),
      // never part of the plan submission. Music/soundtrack mixing is not
      // available yet; captions are likewise post-delivery. Nothing here is
      // persisted or enabled - the plan payload carries no actionable finishing request.
      if (f.requested.includes("narration")) {
        return { ok: false, error: "Narration is added after a reel is delivered, because it needs a script and a separate spend cap." };
      }
      return { ok: false, error: "Music and soundtrack mixing are not available yet; burned captions are added after a reel is delivered." };
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
 * Required-field gaps for one draft scene, in editor field order: story
 * beat, valid duration, visual direction, scene direction note. Empty
 * means the scene is ready to review. Used for compact-row status and for
 * explaining what blocks review - never a substitute for validateFilmPlan,
 * which remains the single authority before review/save.
 */
export function describeSceneGaps(
  scene: Pick<FilmScene, "title" | "durationSeconds" | "visualDirection" | "sourceIntent">
): string[] {
  const gaps: string[] = [];
  if (scene.title.trim() === "") gaps.push("a story beat");
  if (
    !Number.isInteger(scene.durationSeconds) ||
    scene.durationSeconds < FILM_SCENE_MIN_SECONDS ||
    scene.durationSeconds > FILM_SCENE_MAX_SECONDS
  ) {
    gaps.push("a valid duration (3-15 seconds)");
  }
  if (scene.visualDirection.trim() === "") gaps.push("visual direction");
  if (scene.sourceIntent.trim() === "") gaps.push("a scene direction note");
  return gaps;
}

/**
 * Truthful plan summary for the UI. Names the total, the scene count, and
 * the separate-shots reality - never a single long render.
 */
export function describeFilmPlanSummary(plan: Pick<FilmPlan, "targetDurationSeconds" | "scenes">): string {
  const n = plan.scenes.length;
  return `${plan.targetDurationSeconds}-second campaign film · ${n} planned scene${n === 1 ? "" : "s"} · each scene renders as a separate short shot before final assembly.`;
}

export type FilmDurationStatus = "exact" | "under" | "over";

export interface FilmDurationState {
  totalSeconds: number;
  targetSeconds: FilmTargetDuration;
  status: FilmDurationStatus;
  /** Absolute whole-second difference between total and target (0 when exact). */
  differenceSeconds: number;
}

/**
 * Structured duration state for a draft storyboard: exact, under by N, or
 * over by N seconds. Review/Save still requires exact - this only describes
 * the gap so the UI can name it honestly.
 */
export function filmDurationState(
  scenes: Pick<FilmScene, "durationSeconds">[],
  target: FilmTargetDuration
): FilmDurationState {
  const totalSeconds = scenes.reduce(
    (sum, s) => sum + (typeof s.durationSeconds === "number" && Number.isFinite(s.durationSeconds) ? s.durationSeconds : 0),
    0
  );
  if (totalSeconds === target) return { totalSeconds, targetSeconds: target, status: "exact", differenceSeconds: 0 };
  if (totalSeconds < target) {
    return { totalSeconds, targetSeconds: target, status: "under", differenceSeconds: target - totalSeconds };
  }
  return { totalSeconds, targetSeconds: target, status: "over", differenceSeconds: totalSeconds - target };
}

/**
 * Exact-difference copy for an off-target storyboard. Under-filled plans
 * name the missing seconds; over-filled plans ask for manual reduction -
 * there is no automatic correction for over-filled plans.
 */
export function describeFilmDurationMismatch(total: number, target: FilmTargetDuration): string {
  if (total === target) return `${total} of ${target} seconds planned - the storyboard matches the target exactly.`;
  const diff = Math.abs(target - total);
  const unit = diff === 1 ? "second" : "seconds";
  if (total < target) {
    return `${total} of ${target} seconds planned - add ${diff} ${unit} across scenes or add another scene.`;
  }
  return `${total} of ${target} seconds planned - reduce ${diff} ${unit} across scenes to match the ${target}-second target.`;
}

function renumberFilmScenes(scenes: FilmScene[]): FilmScene[] {
  return scenes.map((s, i) => ({ ...s, order: i + 1 }));
}

/**
 * Draft normalization to the single plan-level aspect: every draft scene
 * takes the plan aspect (legacy scenes missing a format are covered too -
 * they simply take the plan aspect). Explicit formats are never preserved
 * here; validation additionally rejects an explicit mismatch on any path
 * that bypasses this normalization rather than silently rewriting it.
 */
export function normalizeFilmDraftScenes(scenes: FilmScene[], aspect: TemplateFormat): FilmScene[] {
  return renumberFilmScenes(scenes.map((s) => ({ ...s, format: aspect })));
}

export type FilmScenesResult = { ok: true; scenes: FilmScene[] } | { ok: false; error: string; scenes: FilmScene[] };

/**
 * Add a draft scene at the end: sequential order, a valid 3-second initial
 * duration, empty story fields (validation rejects review/save until they
 * are filled), planned status, and the global film aspect. Time is never
 * redistributed - the duration state simply reports the new gap.
 */
export function addFilmScene(scenes: FilmScene[], aspect: TemplateFormat): FilmScenesResult {
  if (scenes.length >= FILM_MAX_SCENES) {
    return { ok: false, error: `Campaign films hold at most ${FILM_MAX_SCENES} planned scenes.`, scenes };
  }
  const used = new Set(scenes.map((s) => s.id));
  let k = 1;
  while (used.has(`film-scene-${k}`)) k += 1;
  const scene: FilmScene = {
    id: `film-scene-${k}`,
    order: scenes.length + 1,
    durationSeconds: FILM_SCENE_MIN_SECONDS,
    title: "",
    visualDirection: "",
    sourceIntent: "",
    format: aspect,
    status: "planned"
  };
  return { ok: true, scenes: [...scenes.map((s) => ({ ...s })), scene] };
}

/**
 * Remove a scene without redistributing time: other durations are
 * preserved untouched and order is renumbered to exactly 1..n. Refused
 * below two scenes with an honest message and no mutation.
 */
export function removeFilmScene(scenes: FilmScene[], id: string): FilmScenesResult {
  if (scenes.length <= FILM_MIN_SCENES) {
    return {
      ok: false,
      error: "Campaign films need at least 2 planned scenes - removing this scene is not allowed.",
      scenes
    };
  }
  if (!scenes.some((s) => s.id === id)) {
    return { ok: false, error: "That scene is not in this storyboard - nothing was removed.", scenes };
  }
  return { ok: true, scenes: renumberFilmScenes(scenes.filter((s) => s.id !== id).map((s) => ({ ...s }))) };
}

/**
 * Move a scene one step up or down. The array order is the playback order;
 * order fields are renumbered to exactly 1..n. Edge moves are refused with
 * no mutation (the UI also disables them).
 */
export function moveFilmScene(scenes: FilmScene[], id: string, direction: "up" | "down"): FilmScenesResult {
  const index = scenes.findIndex((s) => s.id === id);
  if (index === -1) {
    return { ok: false, error: "That scene is not in this storyboard - nothing was moved.", scenes };
  }
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= scenes.length) {
    return {
      ok: false,
      error: direction === "up" ? "This scene is already first - it cannot move up." : "This scene is already last - it cannot move down.",
      scenes
    };
  }
  const next = scenes.map((s) => ({ ...s }));
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return { ok: true, scenes: renumberFilmScenes(next) };
}

/** Whether an explicit distribute action can run without breaching 15s per scene. */
export function canDistributeRemainingSeconds(
  scenes: Pick<FilmScene, "durationSeconds">[],
  target: FilmTargetDuration
): boolean {
  const total = scenes.reduce(
    (sum, s) => sum + (typeof s.durationSeconds === "number" && Number.isFinite(s.durationSeconds) ? s.durationSeconds : 0),
    0
  );
  const remaining = target - total;
  if (remaining <= 0) return false;
  const capacity = scenes.reduce(
    (sum, s) => sum + Math.max(0, FILM_SCENE_MAX_SECONDS - s.durationSeconds),
    0
  );
  return capacity >= remaining;
}

/**
 * Explicit, deterministic distribution of the remaining seconds: deal one
 * second at a time in scene order, wrapping round-robin past scenes
 * already at 15 seconds. Never runs automatically - only when the user
 * picks the distribute action. Refused when a full pass places nothing
 * (any further placement would push a scene over 15 seconds), and never
 * corrects an over-filled plan (the user reduces those manually).
 */
export function distributeRemainingSeconds(scenes: FilmScene[], target: FilmTargetDuration): FilmScenesResult {
  const total = scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
  const remaining = target - total;
  if (remaining === 0) {
    return { ok: false, error: `${total} of ${target} seconds planned - the storyboard matches the target exactly.`, scenes };
  }
  if (remaining < 0) {
    return { ok: false, error: describeFilmDurationMismatch(total, target), scenes };
  }
  const next = scenes.map((s) => ({ ...s }));
  let left = remaining;
  while (left > 0) {
    let placed = false;
    for (const slot of next) {
      if (left === 0) break;
      if (slot.durationSeconds < FILM_SCENE_MAX_SECONDS) {
        slot.durationSeconds += 1;
        left -= 1;
        placed = true;
      }
    }
    if (!placed) {
      return {
        ok: false,
        error: `Cannot distribute ${remaining} ${remaining === 1 ? "second" : "seconds"} without pushing a scene over the 15-second maximum - reduce a scene duration or choose a different total.`,
        scenes
      };
    }
  }
  return { ok: true, scenes: renumberFilmScenes(next) };
}

/**
 * Whether the draft is still the untouched deterministic starter storyboard
 * for its target and aspect. Target switches on such a plan may load the
 * new starters directly; anything else requires explicit confirmation.
 */
export function isStarterStoryboardFor(scenes: FilmScene[], target: FilmTargetDuration, aspect: TemplateFormat): boolean {
  return JSON.stringify(scenes) === JSON.stringify(createStarterScenes(target, aspect));
}

/**
 * Whether picking a new total may load its starter scenes directly: only
 * when there is no saved film plan and the draft is still the untouched
 * deterministic starter storyboard for its target and aspect. A saved plan
 * always requires explicit confirmation before replacement, even if its
 * scenes happen to equal the starter scenes - saving is itself an act of
 * authorship that must never be discarded without asking.
 */
export function canSwitchTargetDirectly(
  persisted: FilmPlan | null | undefined,
  scenes: FilmScene[],
  target: FilmTargetDuration,
  aspect: TemplateFormat
): boolean {
  return (persisted === null || persisted === undefined) && isStarterStoryboardFor(scenes, target, aspect);
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
  return `Legacy setting: ${label}s is not supported for one short clip. Choose 3-15 seconds to update this plan.`;
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
