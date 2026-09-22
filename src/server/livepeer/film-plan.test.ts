import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createStarterFilmPlan,
  createStarterScenes,
  describeFilmPlanSummary,
  describeLegacyShortClipSeconds,
  mergeFilmPlanIntoRequest,
  validateFilmPlan,
  STARTER_SCENE_DURATIONS,
  type FilmPlan,
  type FilmScene
} from "./film-plan";
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

  it("rejects totals that miss the target exactly", () => {
    const scenes = (plan().scenes as FilmScene[]).map((s) => ({ ...s }));
    scenes[0] = { ...scenes[0], durationSeconds: 6 };
    const r = validateFilmPlan(plan({ scenes, targetDurationSeconds: 30 }));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /total 31s but the film target is 30s/);
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

  it("rejects any finishing request - all options unavailable", () => {
    const r = validateFilmPlan(plan({ finishing: { requested: ["music"] } }));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /not available in this task/);
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
