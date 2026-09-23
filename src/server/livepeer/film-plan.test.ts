import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addFilmScene,
  canDistributeRemainingSeconds,
  canSwitchTargetDirectly,
  createStarterFilmPlan,
  createStarterScenes,
  describeFilmDurationMismatch,
  describeFilmPlanSummary,
  describeLegacyShortClipSeconds,
  describeSceneGaps,
  distributeRemainingSeconds,
  filmDurationState,
  isStarterStoryboardFor,
  mergeFilmPlanIntoRequest,
  moveFilmScene,
  normalizeFilmDraftScenes,
  removeFilmScene,
  validateFilmPlan,
  FILM_MAX_SCENES,
  STARTER_SCENE_DURATIONS,
  type FilmPlan,
  type FilmScene
} from "./film-plan";
import { buildCreativeSubmitArgs } from "./film-job";
import { validateTemplateSelection } from "./templates";
import type { CampaignRequest } from "../types";

/**
 * Campaign Film planning (first half: plan + confirm only).
 *
 * - Valid 30/45/60 plans pass; every invalid shape is rejected before
 *   persistence (fractional, <3, >15, mismatched total, 1 scene, >30
 *   scenes, bad target/mode/title/budget/order/format/status/finishing).
 * - Starter scenes are deterministic, whole 3-15s, and sum exactly.
 * - Legacy 40s short-clip values render the exact legacy notice and fail
 *   validation; valid values normalize to null.
 * - Persistence merges onto the request JSON without touching the template
 *   production spec; short-clip/template payloads gain no film keys.
 * - No Livepeer calls, no DKG, no network.
 */

function scene(over: Partial<FilmScene> = {}): FilmScene {
  return {
    id: "film-scene-1",
    order: 1,
    durationSeconds: 5,
    title: "Hook",
    visualDirection: "Close framing on the approved product in use.",
    sourceIntent: "Approved source media as the visual reference.",
    format: "9:16",
    status: "planned",
    ...over
  };
}

function plan(over: Record<string, unknown> = {}): Record<string, unknown> {
  const scenes = [5, 5, 5, 5, 5, 5].map((durationSeconds, i) =>
    scene({ id: `film-scene-${i + 1}`, order: i + 1, durationSeconds, title: `Beat ${i + 1}` })
  );
  return {
    mode: "campaign_film",
    title: "Autumn launch reel",
    targetDurationSeconds: 30,
    aspectRatio: "9:16",
    budgetCapUsd: 25,
    scenes,
    ...over
  };
}

describe("valid 30/45/60 film plans", () => {
  for (const target of [30, 45, 60] as const) {
    it(`accepts a valid ${target}s plan`, () => {
      const r = createStarterFilmPlan(target, { title: `${target}s reel`, budgetCapUsd: 25 });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.filmPlan.targetDurationSeconds, target);
      assert.equal(r.filmPlan.mode, "campaign_film");
      const total = r.filmPlan.scenes.reduce((s, x) => s + x.durationSeconds, 0);
      assert.equal(total, target);
    });
  }

  it("rounds a string budget to cents and trims the title", () => {
    const r = validateFilmPlan(plan({ title: "  Reel  ", budgetCapUsd: "25.456" }));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.filmPlan.title, "Reel");
    assert.equal(r.filmPlan.budgetCapUsd, 25.46);
  });

  it("accepts an explicitly empty finishing request", () => {
    const r = validateFilmPlan(plan({ finishing: { requested: [] } }));
    assert.equal(r.ok, true);
  });
});

describe("invalid plans are rejected before persistence", () => {
  it("rejects fractional scene durations", () => {
    const scenes = (plan().scenes as FilmScene[]).map((s) => ({ ...s }));
    scenes[0] = { ...scenes[0], durationSeconds: 7.5 };
    const r = validateFilmPlan(plan({ scenes }));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /whole number/);
  });

  it("rejects scenes under 3s and over 15s", () => {
    const scenes = (plan().scenes as FilmScene[]).map((s) => ({ ...s }));
    scenes[0] = { ...scenes[0], durationSeconds: 2 };
    assert.equal(validateFilmPlan(plan({ scenes })).ok, false);
    scenes[0] = { ...scenes[0], durationSeconds: 16 };
    const r = validateFilmPlan(plan({ scenes }));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /3–15/);
  });

  it("rejects totals that miss the target with the exact difference", () => {
    const scenes = (plan().scenes as FilmScene[]).map((s) => ({ ...s }));
    scenes[0] = { ...scenes[0], durationSeconds: 6 };
    const over = validateFilmPlan(plan({ scenes, targetDurationSeconds: 30 }));
    assert.equal(over.ok, false);
    if (over.ok) return;
    assert.equal(over.error, "31 of 30 seconds planned — reduce 1 second across scenes to match the 30-second target.");
    const short = (plan().scenes as FilmScene[]).map((s, i) => ({ ...s, durationSeconds: i === 0 ? 3 : 4 }));
    // 3 + 4*5 = 23 of 30: under by 7.
    const under = validateFilmPlan(plan({ scenes: short, targetDurationSeconds: 30 }));
    assert.equal(under.ok, false);
    if (under.ok) return;
    assert.equal(under.error, "23 of 30 seconds planned — add 7 seconds across scenes or add another scene.");
  });

  it("rejects 1-scene and >30-scene plans", () => {
    const one = validateFilmPlan(plan({ scenes: [scene()] }));
    assert.equal(one.ok, false);
    if (!one.ok) assert.match(one.error, /at least 2/);
    const many: FilmScene[] = Array.from({ length: 31 }, (_, i) =>
      scene({ id: `film-scene-${i + 1}`, order: i + 1, durationSeconds: 3, title: `Beat ${i + 1}` })
    );
    const tooMany = validateFilmPlan(plan({ targetDurationSeconds: 60, scenes: many }));
    assert.equal(tooMany.ok, false);
    if (!tooMany.ok) assert.match(tooMany.error, /at most 30/);
  });

  it("rejects a 40-second target - never a plannable total", () => {
    const r = validateFilmPlan(plan({ targetDurationSeconds: 40 }));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /30, 45, or 60/);
  });

  it("rejects 4:5 film aspects - the provider film surface has none", () => {
    const aspect = validateFilmPlan(plan({ aspectRatio: "4:5" }));
    assert.equal(aspect.ok, false);
    if (aspect.ok) return;
    assert.match(aspect.error, /no 4:5 aspect/);
    assert.match(aspect.error, /short image packs/);
    const scenes = (plan().scenes as FilmScene[]).map((s) => ({ ...s }));
    scenes[0] = { ...scenes[0], format: "4:5" };
    const sceneAspect = validateFilmPlan(plan({ scenes }));
    assert.equal(sceneAspect.ok, false);
    if (sceneAspect.ok) return;
    assert.match(sceneAspect.error, /4:5 is not supported for Campaign Film/);
  });

  it("rejects short_clip mode and unknown modes", () => {
    const short = validateFilmPlan(plan({ mode: "short_clip" }));
    assert.equal(short.ok, false);
    if (!short.ok) assert.match(short.error, /3–15 second picker/);
    assert.equal(validateFilmPlan(plan({ mode: "feature" })).ok, false);
  });

  it("rejects missing title, bad aspect, and missing/non-positive budget", () => {
    assert.equal(validateFilmPlan(plan({ title: "   " })).ok, false);
    assert.equal(validateFilmPlan(plan({ title: "x".repeat(121) })).ok, false);
    assert.equal(validateFilmPlan(plan({ aspectRatio: "2:3" })).ok, false);
    const missing = validateFilmPlan(plan({ budgetCapUsd: undefined }));
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.error, /budget cap.*required/);
    assert.equal(validateFilmPlan(plan({ budgetCapUsd: 0 })).ok, false);
    assert.equal(validateFilmPlan(plan({ budgetCapUsd: -5 })).ok, false);
  });

  it("rejects unstable ordering: gaps, dupes, and shuffled arrays", () => {
    const scenes = (plan().scenes as FilmScene[]).map((s) => ({ ...s }));
    const gapped = scenes.map((s, i) => ({ ...s, order: i === 1 ? 3 : s.order }));
    assert.equal(validateFilmPlan(plan({ scenes: gapped })).ok, false);
    const duped = scenes.map((s) => ({ ...s }));
    duped[0] = { ...duped[0], id: "same-id" };
    duped[1] = { ...duped[1], id: "same-id" };
    const dupeId = validateFilmPlan(plan({ scenes: duped }));
    assert.equal(dupeId.ok, false);
    if (!dupeId.ok) assert.match(dupeId.error, /more than once/);
  });

  it("rejects empty beat/direction/intent, bad format, and non-planned status", () => {
    const scenes = (plan().scenes as FilmScene[]).map((s) => ({ ...s }));
    assert.equal(validateFilmPlan(plan({ scenes: scenes.map((s, i) => (i === 0 ? { ...s, title: " " } : s)) })).ok, false);
    assert.equal(validateFilmPlan(plan({ scenes: scenes.map((s, i) => (i === 0 ? { ...s, visualDirection: "" } : s)) })).ok, false);
    assert.equal(validateFilmPlan(plan({ scenes: scenes.map((s, i) => (i === 0 ? { ...s, sourceIntent: "" } : s)) })).ok, false);
    assert.equal(validateFilmPlan(plan({ scenes: scenes.map((s, i) => (i === 0 ? { ...s, format: "2:3" } : s)) })).ok, false);
    const rendering = validateFilmPlan(plan({ scenes: scenes.map((s, i) => (i === 0 ? { ...s, status: "rendering" } : s)) }));
    assert.equal(rendering.ok, false);
    if (!rendering.ok) assert.match(rendering.error, /only "planned"/);
  });

  it("rejects narration in the plan with the post-delivery message", () => {
    const r = validateFilmPlan(plan({ finishing: { requested: ["narration"] } }));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error, "Narration is added after a reel is delivered, because it needs a script and a separate spend cap.");
  });

  it("rejects narration combined with other finishing the same way", () => {
    const r = validateFilmPlan(plan({ finishing: { requested: ["music", "narration"] } }));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error, "Narration is added after a reel is delivered, because it needs a script and a separate spend cap.");
  });

  it("rejects music/subtitles without implying they are plan-submittable", () => {
    for (const requested of [["music"], ["subtitles"], ["music", "subtitles"]]) {
      const r = validateFilmPlan(plan({ finishing: { requested } }));
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.error, "Music and soundtrack mixing are not available yet; burned captions are added after a reel is delivered.");
    }
  });
});

describe("deterministic starter scenes", () => {
  it("30s is six 5s scenes; 45s six scenes; 60s eight scenes - all exact", () => {
    const thirty = createStarterScenes(30);
    assert.deepEqual(thirty.map((s) => s.durationSeconds), [5, 5, 5, 5, 5, 5]);
    const fortyFive = createStarterScenes(45);
    assert.equal(fortyFive.length, 6);
    assert.deepEqual(fortyFive.map((s) => s.durationSeconds), STARTER_SCENE_DURATIONS[45]);
    assert.equal(fortyFive.reduce((s, x) => s + x.durationSeconds, 0), 45);
    const sixty = createStarterScenes(60);
    assert.equal(sixty.length, 8);
    assert.equal(sixty.reduce((s, x) => s + x.durationSeconds, 0), 60);
    for (const s of [...thirty, ...fortyFive, ...sixty]) {
      assert.ok(Number.isInteger(s.durationSeconds) && s.durationSeconds >= 3 && s.durationSeconds <= 15);
      assert.equal(s.status, "planned");
    }
  });

  it("starters are deterministic: stable ids, sequential order, Hook first, CTA last", () => {
    const a = createStarterScenes(45, "1:1");
    const b = createStarterScenes(45, "1:1");
    assert.deepEqual(a, b);
    assert.deepEqual(a.map((s) => s.id), ["film-scene-1", "film-scene-2", "film-scene-3", "film-scene-4", "film-scene-5", "film-scene-6"]);
    assert.deepEqual(a.map((s) => s.order), [1, 2, 3, 4, 5, 6]);
    assert.equal(a[0].title, "Hook");
    assert.equal(a[a.length - 1].title, "Call to action");
    assert.ok(a.every((s) => s.format === "1:1" && s.visualDirection.length > 0 && s.sourceIntent.length > 0));
  });
});

describe("truthful summary copy", () => {
  it("states the exact 45s summary", () => {
    const r = createStarterFilmPlan(45, { title: "Reel", budgetCapUsd: 10 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(
      describeFilmPlanSummary(r.filmPlan),
      "45-second campaign film · 6 planned scenes · each scene renders as a separate short shot before final assembly."
    );
  });

  it("scales counts for 30s and 60s plans", () => {
    assert.equal(
      describeFilmPlanSummary({ targetDurationSeconds: 30, scenes: createStarterScenes(30) }),
      "30-second campaign film · 6 planned scenes · each scene renders as a separate short shot before final assembly."
    );
    assert.equal(
      describeFilmPlanSummary({ targetDurationSeconds: 60, scenes: createStarterScenes(60) }),
      "60-second campaign film · 8 planned scenes · each scene renders as a separate short shot before final assembly."
    );
  });
});

describe("legacy short-clip normalization", () => {
  it("renders the exact notice for a 40s legacy value", () => {
    assert.equal(
      describeLegacyShortClipSeconds(40),
      "Legacy setting: 40s is not supported for one short clip. Choose 3–15 seconds to update this plan."
    );
  });

  it("flags other invalid legacy values, clears valid and absent ones", () => {
    assert.match(describeLegacyShortClipSeconds(16) ?? "", /Legacy setting: 16s/);
    assert.match(describeLegacyShortClipSeconds(7.5) ?? "", /Legacy setting: 7.5s/);
    assert.match(describeLegacyShortClipSeconds(2) ?? "", /Legacy setting: 2s/);
    assert.equal(describeLegacyShortClipSeconds(3), null);
    assert.equal(describeLegacyShortClipSeconds(6), null);
    assert.equal(describeLegacyShortClipSeconds(15), null);
    assert.equal(describeLegacyShortClipSeconds(null), null);
    assert.equal(describeLegacyShortClipSeconds(undefined), null);
    assert.equal(describeLegacyShortClipSeconds(""), null);
  });

  it("server selection validation rejects a 40s short clip", () => {
    const r = validateTemplateSelection(
      { templateId: "creator-campaign", packSize: "campaign", assetTypes: ["image", "motion"], qualityProfile: "balanced", motionSeconds: 40 },
      16
    );
    assert.equal(r.ok, false);
  });
});

describe("persistence merge and short-clip compatibility", () => {
  function request(): CampaignRequest {
    return {
      platform: "instagram",
      country: "US",
      requestedClaims: [],
      transformation: "video",
      creativeBrief: "Launch",
      qualityProfile: "balanced",
      productionSpec: {
        templateId: "creator-campaign",
        packSize: "campaign",
        assetTypes: ["image", "motion"],
        qualityProfile: "balanced",
        motionSeconds: 5
      }
    };
  }

  it("merges the film plan without touching the template production spec", () => {
    const before = request();
    const starter = createStarterFilmPlan(30, { title: "Reel", budgetCapUsd: 20 });
    assert.equal(starter.ok, true);
    if (!starter.ok) return;
    const after = mergeFilmPlanIntoRequest(before, starter.filmPlan);
    assert.deepEqual(after.filmPlan, starter.filmPlan);
    assert.deepEqual(after.productionSpec, before.productionSpec);
    assert.equal(after.creativeBrief, "Launch");
    assert.equal(before.filmPlan, undefined);
  });

  it("short-clip template payloads gain no film keys", () => {
    const r = validateTemplateSelection(
      { templateId: "creator-campaign", packSize: "quick", assetTypes: ["image", "motion"], qualityProfile: "balanced", motionSeconds: 5 },
      16
    );
    assert.equal(r.ok, true);
    if (!r.ok || !r.spec) return;
    assert.ok(!("filmPlan" in r.spec));
    assert.ok(!("film" in r.spec));
    const withExtra = validateTemplateSelection(
      { templateId: "creator-campaign", packSize: "quick", assetTypes: ["image", "motion"], qualityProfile: "balanced", motionSeconds: 5, filmPlan: plan() } as unknown,
      16
    );
    assert.equal(withExtra.ok, true);
    if (!withExtra.ok || !withExtra.spec) return;
    assert.ok(!("filmPlan" in withExtra.spec));
  });

  it("4:5 stays available for short-clip template flows", () => {
    const r = validateTemplateSelection(
      { templateId: "creator-campaign", packSize: "quick", assetTypes: ["image"], formats: ["4:5"], qualityProfile: "balanced" },
      16
    );
    assert.equal(r.ok, true);
  });

  it("saved film plans validate unchanged (round-trip stability)", () => {
    const starter = createStarterFilmPlan(60, { title: "Long reel", budgetCapUsd: 42.5, aspectRatio: "16:9" });
    assert.equal(starter.ok, true);
    if (!starter.ok) return;
    const saved: FilmPlan = JSON.parse(JSON.stringify(starter.filmPlan)) as FilmPlan;
    const reread = validateFilmPlan(saved);
    assert.equal(reread.ok, true);
    if (!reread.ok) return;
    assert.deepEqual(reread.filmPlan, starter.filmPlan);
  });
});

describe("one aspect ratio per Campaign Film", () => {
  it("normalizes every draft scene to the plan aspect", () => {
    const scenes = createStarterScenes(30, "9:16");
    const normalized = normalizeFilmDraftScenes(scenes, "1:1");
    assert.ok(normalized.every((s) => s.format === "1:1"));
    assert.deepEqual(normalized.map((s) => s.order), [1, 2, 3, 4, 5, 6]);
    // Input untouched.
    assert.ok(scenes.every((s) => s.format === "9:16"));
  });

  it("rejects an explicitly mismatched scene format instead of silently submitting the plan aspect", () => {
    const scenes = (plan().scenes as FilmScene[]).map((s) => ({ ...s }));
    scenes[2] = { ...scenes[2], format: "1:1" };
    const r = validateFilmPlan(plan({ aspectRatio: "9:16", scenes }));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /does not match the film aspect 9:16/);
    assert.match(r.error, /one aspect ratio per Campaign Film/);
  });

  it("normalizes a legacy scene missing a format to the plan aspect", () => {
    const scenes = (plan().scenes as FilmScene[]).map((s) => ({ ...s }));
    const { format: _dropped, ...legacy } = scenes[0];
    void _dropped;
    const r = validateFilmPlan(plan({ scenes: [legacy, ...scenes.slice(1)] }));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.filmPlan.scenes[0].format, "9:16");
  });
});

describe("safe storyboard operations", () => {
  it("add creates a stable-ID 3-second draft scene with empty fields and the global aspect", () => {
    const scenes = createStarterScenes(30, "1:1");
    const added = addFilmScene(scenes, "1:1");
    assert.equal(added.ok, true);
    assert.equal(added.scenes.length, 7);
    const last = added.scenes[added.scenes.length - 1];
    assert.equal(last.order, 7);
    assert.equal(last.durationSeconds, 3);
    assert.equal(last.title, "");
    assert.equal(last.visualDirection, "");
    assert.equal(last.sourceIntent, "");
    assert.equal(last.format, "1:1");
    assert.equal(last.status, "planned");
    assert.ok(last.id.length > 0);
    assert.equal(new Set(added.scenes.map((s) => s.id)).size, 7);
    assert.deepEqual(added.scenes.map((s) => s.order), [1, 2, 3, 4, 5, 6, 7]);
    // Input untouched.
    assert.equal(scenes.length, 6);
  });

  it("a newly added draft scene blocks review/save until its fields are filled", () => {
    const scenes = createStarterScenes(30, "9:16");
    const added = addFilmScene(scenes, "9:16");
    assert.equal(added.ok, true);
    const filled = added.scenes.map((s) =>
      s.title === "" ? { ...s, title: "New beat", visualDirection: "Steady framing.", sourceIntent: "Approved reference as text." } : s
    );
    // 33s total now: completeness and exactness are both enforced.
    assert.equal(validateFilmPlan(plan({ scenes: added.scenes })).ok, false);
    assert.equal(validateFilmPlan(plan({ scenes: filled })).ok, false);
  });

  it("remove preserves other durations and renumbers to 1..n without redistributing", () => {
    const scenes = createStarterScenes(30, "9:16");
    const removed = removeFilmScene(scenes, "film-scene-1");
    assert.equal(removed.ok, true);
    assert.deepEqual(removed.scenes.map((s) => s.durationSeconds), [5, 5, 5, 5, 5]);
    assert.deepEqual(removed.scenes.map((s) => s.order), [1, 2, 3, 4, 5]);
    assert.deepEqual(removed.scenes.map((s) => s.id), ["film-scene-2", "film-scene-3", "film-scene-4", "film-scene-5", "film-scene-6"]);
  });

  it("refuses removal below two scenes with an honest message and no mutation", () => {
    const two: FilmScene[] = [
      scene({ id: "a", order: 1, durationSeconds: 15, title: "Hook" }),
      scene({ id: "b", order: 2, durationSeconds: 15, title: "CTA" })
    ];
    const before = two.map((s) => ({ ...s }));
    const r = removeFilmScene(two, "a");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /at least 2/);
    assert.deepEqual(two, before);
    assert.deepEqual(r.scenes, before);
  });

  it("refuses to add beyond the scene maximum", () => {
    const many: FilmScene[] = Array.from({ length: FILM_MAX_SCENES }, (_, i) =>
      scene({ id: `film-scene-${i + 1}`, order: i + 1, durationSeconds: 3, title: `Beat ${i + 1}` })
    );
    const r = addFilmScene(many, "9:16");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, new RegExp(`at most ${FILM_MAX_SCENES}`));
    assert.equal(many.length, FILM_MAX_SCENES);
  });

  it("move up/down reorders and renumbers; edge moves are refused", () => {
    const scenes = createStarterScenes(30, "9:16");
    const down = moveFilmScene(scenes, "film-scene-1", "down");
    assert.equal(down.ok, true);
    assert.deepEqual(down.scenes.map((s) => s.id), ["film-scene-2", "film-scene-1", "film-scene-3", "film-scene-4", "film-scene-5", "film-scene-6"]);
    assert.deepEqual(down.scenes.map((s) => s.order), [1, 2, 3, 4, 5, 6]);
    const up = moveFilmScene(down.scenes, "film-scene-1", "up");
    assert.equal(up.ok, true);
    assert.deepEqual(up.scenes.map((s) => s.id), scenes.map((s) => s.id));
    const topRefused = moveFilmScene(scenes, "film-scene-1", "up");
    assert.equal(topRefused.ok, false);
    assert.deepEqual(topRefused.scenes, scenes);
    const bottomRefused = moveFilmScene(scenes, "film-scene-6", "down");
    assert.equal(bottomRefused.ok, false);
    assert.deepEqual(bottomRefused.scenes, scenes);
  });
});

describe("exact duration behavior", () => {
  it("reports exact, under-by-N, and over-by-N states", () => {
    const exact = filmDurationState(createStarterScenes(30), 30);
    assert.deepEqual(exact, { totalSeconds: 30, targetSeconds: 30, status: "exact", differenceSeconds: 0 });
    const five: FilmScene[] = [5, 5, 5, 5, 5].map((durationSeconds, i) =>
      scene({ id: `film-scene-${i + 1}`, order: i + 1, durationSeconds, title: `Beat ${i + 1}` })
    );
    const under = filmDurationState(five, 30);
    assert.deepEqual(under, { totalSeconds: 25, targetSeconds: 30, status: "under", differenceSeconds: 5 });
    assert.equal(describeFilmDurationMismatch(under.totalSeconds, 30), "25 of 30 seconds planned — add 5 seconds across scenes or add another scene.");
    const over = filmDurationState([...five, scene({ id: "film-scene-6", order: 6, durationSeconds: 6, title: "Extra" })], 30);
    assert.deepEqual(over, { totalSeconds: 31, targetSeconds: 30, status: "over", differenceSeconds: 1 });
    assert.equal(
      describeFilmDurationMismatch(over.totalSeconds, 30),
      "31 of 30 seconds planned — reduce 1 second across scenes to match the 30-second target."
    );
  });

  it("distributes remaining seconds deterministically, one second at a time in scene order", () => {
    const five: FilmScene[] = [5, 5, 5, 5, 5].map((durationSeconds, i) =>
      scene({ id: `film-scene-${i + 1}`, order: i + 1, durationSeconds, title: `Beat ${i + 1}` })
    );
    const a = distributeRemainingSeconds(five, 30);
    const b = distributeRemainingSeconds(five, 30);
    assert.equal(a.ok, true);
    assert.deepEqual(a.scenes.map((s) => s.durationSeconds), [6, 6, 6, 6, 6]);
    assert.deepEqual(a, b);
    assert.deepEqual(a.scenes.map((s) => s.order), [1, 2, 3, 4, 5]);
  });

  it("refuses distribution when any scene would exceed 15 seconds, without mutating", () => {
    const capped: FilmScene[] = [15, 15, 15].map((durationSeconds, i) =>
      scene({ id: `film-scene-${i + 1}`, order: i + 1, durationSeconds, title: `Beat ${i + 1}` })
    );
    const before = capped.map((s) => ({ ...s }));
    const r = distributeRemainingSeconds(capped, 60);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /15-second maximum/);
    assert.deepEqual(capped, before);
    assert.deepEqual(r.scenes, before);
    assert.equal(canDistributeRemainingSeconds(capped, 60), false);
    const roomy: FilmScene[] = [5, 5, 5, 5, 5].map((durationSeconds, i) =>
      scene({ id: `film-scene-${i + 1}`, order: i + 1, durationSeconds, title: `Beat ${i + 1}` })
    );
    assert.equal(canDistributeRemainingSeconds(roomy, 30), true);
    assert.equal(canDistributeRemainingSeconds(createStarterScenes(30), 30), false);
  });

  it("never auto-corrects an over-filled plan - distribution is refused with the honest copy", () => {
    const over: FilmScene[] = [6, 5, 5, 5, 5, 5].map((durationSeconds, i) =>
      scene({ id: `film-scene-${i + 1}`, order: i + 1, durationSeconds, title: `Beat ${i + 1}` })
    );
    const r = distributeRemainingSeconds(over, 30);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error, "31 of 30 seconds planned — reduce 1 second across scenes to match the 30-second target.");
  });
});

describe("destructive target changes require confirmation", () => {
  it("untouched starters are detected; any edit marks the storyboard custom", () => {
    const starter = createStarterScenes(30, "9:16");
    assert.equal(isStarterStoryboardFor(starter, 30, "9:16"), true);
    assert.equal(isStarterStoryboardFor(starter, 45, "9:16"), false);
    assert.equal(isStarterStoryboardFor(starter, 30, "1:1"), false);
    const edited = starter.map((s, i) => (i === 0 ? { ...s, title: "Custom hook" } : s));
    assert.equal(isStarterStoryboardFor(edited, 30, "9:16"), false);
    const added = addFilmScene(starter, "9:16");
    assert.equal(added.ok, true);
    assert.equal(isStarterStoryboardFor(added.scenes, 30, "9:16"), false);
  });

  it("a saved plan always requires confirmation, even when its scenes equal the starters", () => {
    const starter = createStarterScenes(30, "9:16");
    // Fresh untouched draft: direct switch allowed.
    assert.equal(canSwitchTargetDirectly(null, starter, 30, "9:16"), true);
    assert.equal(canSwitchTargetDirectly(undefined, starter, 30, "9:16"), true);
    // Any edit blocks the direct switch.
    const edited = starter.map((s, i) => (i === 0 ? { ...s, title: "Custom hook" } : s));
    assert.equal(canSwitchTargetDirectly(null, edited, 30, "9:16"), false);
    // A saved plan blocks the direct switch even when its scenes exactly
    // match the deterministic starters - saving is authorship.
    const saved = createStarterFilmPlan(30, { title: "Reel", budgetCapUsd: 25 });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.deepEqual(saved.filmPlan.scenes, starter);
    assert.equal(canSwitchTargetDirectly(saved.filmPlan, saved.filmPlan.scenes, 30, "9:16"), false);
    assert.equal(canSwitchTargetDirectly(saved.filmPlan, edited, 30, "9:16"), false);
  });
});

describe("scene completeness gaps", () => {
  it("reports no gaps for a complete scene", () => {
    assert.deepEqual(describeSceneGaps(createStarterScenes(30)[0]), []);
  });

  it("names every missing required field in editor order", () => {
    const added = addFilmScene(createStarterScenes(30, "9:16"), "9:16");
    assert.equal(added.ok, true);
    const draft = added.scenes[added.scenes.length - 1];
    assert.deepEqual(describeSceneGaps(draft), ["a story beat", "visual direction", "a scene direction note"]);
  });

  it("flags blank text and out-of-range or fractional durations", () => {
    const base = createStarterScenes(30)[0];
    assert.deepEqual(describeSceneGaps({ ...base, title: "   " }), ["a story beat"]);
    assert.deepEqual(describeSceneGaps({ ...base, durationSeconds: 2 }), ["a valid duration (3–15 seconds)"]);
    assert.deepEqual(describeSceneGaps({ ...base, durationSeconds: 16 }), ["a valid duration (3–15 seconds)"]);
    assert.deepEqual(describeSceneGaps({ ...base, durationSeconds: 7.5 }), ["a valid duration (3–15 seconds)"]);
    assert.deepEqual(describeSceneGaps({ ...base, visualDirection: "", sourceIntent: "" }), [
      "visual direction",
      "a scene direction note"
    ]);
  });
});

describe("provider truth: only the global aspect is sent", () => {
  function divergentPlan(): FilmPlan {
    const starter = createStarterFilmPlan(30, { title: "Reel", budgetCapUsd: 25 });
    assert.equal(starter.ok, true);
    if (!starter.ok) throw new Error("starter must validate");
    return starter.filmPlan;
  }

  it("scene entries carry title/prompt/duration only, with one global aspect_ratio", () => {
    const planValue = divergentPlan();
    const args = buildCreativeSubmitArgs(planValue, "permitframe_film_test");
    assert.equal(args.aspect_ratio, "9:16");
    for (const s of args.scenes) {
      assert.deepEqual(Object.keys(s).sort(), ["duration", "prompt", "title"]);
    }
  });

  it("a divergent scene format never reaches the provider - the global aspect wins", () => {
    const planValue = divergentPlan();
    const tampered = {
      ...planValue,
      scenes: planValue.scenes.map((s, i) => (i === 0 ? { ...s, format: "1:1" as const } : s))
    };
    const args = buildCreativeSubmitArgs(tampered, "permitframe_film_test");
    assert.equal(args.aspect_ratio, "9:16");
    assert.ok(args.scenes.every((s) => !("format" in s) && !("aspect_ratio" in s) && !("aspectRatio" in s)));
  });
});
