import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as facade from "./templates";
import {
  listTemplates, getTemplate, findRecipe, findRecipeAnywhere, pickRecipes,
  closeSelectionDependencies, validateTemplateSelection, buildTemplateStages,
  toPlanStages, estimateTemplateMinutes,
  type TemplateSelection, type ProductionTemplate
} from "./templates";
import { TEMPLATE_IDS } from "./template-catalogue";
import { pickRecipes as pickDirect } from "./template-selection";
import { validateTemplateSelection as validateDirect } from "./template-validation";
import { buildTemplateStages as buildDirect, toPlanStages as toPlanDirect } from "./template-plan-builder";
import { estimateTemplateMinutes as estimateDirect } from "./template-estimates";

/**
 * Template façade compatibility after the templates.ts modularization
 * (catalogue / selection / validation / plan-builder / estimates behind
 * a 51-line façade).
 *
 * - Every public name still resolves through "./templates" and is
 *   reference-identical to the extracted implementation.
 * - Coverage pins the six required areas through the façade: pack
 *   filtering, transitive closure (incl. motion-only auto-including its
 *   keyframe), invalid custom rejection, plan ids/dependencies,
 *   duration/aspect metadata, and unchanged estimates. No Livepeer calls.
 */

function selection(over: Partial<TemplateSelection> = {}): TemplateSelection {
  return {
    templateId: "creator-campaign",
    packSize: "campaign",
    assetTypes: ["image", "motion"],
    qualityProfile: "balanced",
    ...over
  } as TemplateSelection;
}

function resolveCapability(role: string) {
  return { capability: role === "imageToVideo" ? "kling-v3-turbo-i2v" : "flux-dev" };
}

describe("façade identity", () => {
  it("functions resolve to the extracted implementations", () => {
    assert.equal(facade.pickRecipes, pickDirect);
    assert.equal(facade.validateTemplateSelection, validateDirect);
    assert.equal(facade.buildTemplateStages, buildDirect);
    assert.equal(facade.toPlanStages, toPlanDirect);
    assert.equal(facade.estimateTemplateMinutes, estimateDirect);
    for (const fn of [listTemplates, getTemplate, findRecipe, findRecipeAnywhere, pickRecipes, closeSelectionDependencies, validateTemplateSelection, buildTemplateStages, toPlanStages, estimateTemplateMinutes]) {
      assert.equal(typeof fn, "function");
    }
  });

  it("catalogue constants survive the move intact", () => {
    assert.deepEqual(facade.TEMPLATE_IDS, TEMPLATE_IDS);
    assert.deepEqual(facade.TEMPLATE_IDS, ["creator-campaign", "product-launch", "real-estate", "hospitality", "automotive"]);
    assert.equal(facade.listTemplates().length, 5);
    assert.equal(facade.PACK_SIZE_GUIDANCE.campaign.min, 5);
  });
});

describe("1. template/pack filtering", () => {
  it("quick picks only quickPick recipes; campaign drops optionals", () => {
    const template = getTemplate("creator-campaign") as ProductionTemplate;
    const quick = pickRecipes(template, selection({ packSize: "quick" }));
    assert.ok(quick.length > 0 && quick.length < template.recipes.length);
    assert.ok(quick.every((r) => r.quickPick));
    const campaign = pickRecipes(template, selection({ packSize: "campaign" }));
    assert.ok(campaign.every((r) => !r.optional));
    assert.ok(campaign.length > quick.length);
  });

  it("format filter keeps non-image assets regardless of format", () => {
    const template = getTemplate("creator-campaign") as ProductionTemplate;
    const only11 = pickRecipes(template, selection({ packSize: "full", formats: ["1:1"] }));
    assert.ok(only11.some((r) => r.assetType === "motion"), "motion survives an image-format filter");
    assert.ok(only11.filter((r) => r.assetType === "image").every((r) => r.format === "1:1"));
  });

  it("asset-type exclusion drops whole classes", () => {
    const template = getTemplate("creator-campaign") as ProductionTemplate;
    const images = pickRecipes(template, selection({ packSize: "full", assetTypes: ["image"] }));
    assert.ok(images.every((r) => r.assetType === "image"));
  });
});

describe("2. transitive dependency closure", () => {
  it("motion-only custom selection auto-includes its keyframe with requiredFor", () => {
    const template = getTemplate("creator-campaign") as ProductionTemplate;
    const picked = pickRecipes(template, selection({ packSize: "custom", stageIds: ["cc-motion-916"], assetTypes: ["image", "motion"] }));
    assert.deepEqual(picked.map((r) => r.id), ["cc-motion-916"]);
    const closed = closeSelectionDependencies(template, picked);
    assert.equal(closed.ok, true);
    if (!closed.ok) return;
    const ids = closed.recipes.map((r) => r.id);
    assert.ok(ids.includes("cc-motion-916") && ids.includes("cc-hero-916"), "keyframe auto-included");
    const auto = closed.autoIncluded.find((a) => a.id === "cc-hero-916");
    assert.ok(auto, "auto-inclusion reported");
    assert.ok(auto.requiredFor.includes("Motion asset (9:16)"));
  });

  it("closure preserves catalogue order", () => {
    const template = getTemplate("creator-campaign") as ProductionTemplate;
    const picked = pickRecipes(template, selection({ packSize: "custom", stageIds: ["cc-motion-916", "cc-feed-11"], assetTypes: ["image", "motion"] }));
    const closed = closeSelectionDependencies(template, picked);
    assert.equal(closed.ok, true);
    if (!closed.ok) return;
    const ids = closed.recipes.map((r) => r.id);
    assert.deepEqual(ids, ["cc-hero-916", "cc-feed-11", "cc-motion-916"]);
  });
});

describe("3. invalid custom selection rejection", () => {
  it("unknown template, stage, pack, format, and over-bound customs fail with guidance", () => {
    assert.match(validateTemplateSelection({ templateId: "nope" }, 16).error ?? "", /Unknown template/);
    assert.match(
      validateTemplateSelection({ templateId: "creator-campaign", packSize: "custom", stageIds: ["ghost"], assetTypes: ["image"], qualityProfile: "balanced" }, 16).error ?? "",
      /Unknown stage ids/
    );
    assert.match(
      validateTemplateSelection({ templateId: "creator-campaign", packSize: "mega", assetTypes: ["image"], qualityProfile: "balanced" }, 16).error ?? "",
      /Pack size must be/
    );
    assert.match(
      validateTemplateSelection({ templateId: "creator-campaign", packSize: "quick", assetTypes: ["image"], formats: ["2:3"], qualityProfile: "balanced" }, 16).error ?? "",
      /Unknown format/
    );
    const tooMany = (getTemplate("creator-campaign") as ProductionTemplate).recipes.map((r) => r.id);
    assert.match(
      validateTemplateSelection({ templateId: "creator-campaign", packSize: "custom", stageIds: tooMany, assetTypes: ["image", "motion"], qualityProfile: "balanced" }, 3).error ?? "",
      /bounded at 3 stages/
    );
    assert.match(
      validateTemplateSelection({ templateId: "creator-campaign", packSize: "quick", assetTypes: [], qualityProfile: "balanced" }, 16).error ?? "",
      /at least one asset type/
    );
  });

  it("motion length outside 3-15 is rejected, never clamped", () => {
    assert.match(
      validateTemplateSelection({ templateId: "creator-campaign", packSize: "quick", assetTypes: ["image", "motion"], qualityProfile: "balanced", motionSeconds: 2 }, 16).error ?? "",
      /motion/i
    );
    const ok = validateTemplateSelection({ templateId: "creator-campaign", packSize: "quick", assetTypes: ["image", "motion"], qualityProfile: "balanced", motionSeconds: 6 }, 16);
    assert.equal(ok.ok, true);
    assert.equal(ok.spec?.motionSeconds, 6);
  });
});

describe("4. plan stage ids and dependencies unchanged", () => {
  it("built stages keep recipe ids, DAG edges, roles, and labels", () => {
    const template = getTemplate("creator-campaign") as ProductionTemplate;
    const built = buildTemplateStages(template, selection({ packSize: "quick" }), resolveCapability);
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const stages = toPlanStages(built.plan, "balanced");
    const byId = new Map(stages.map((s) => [s.id, s]));
    assert.deepEqual(stages.map((s) => s.id), ["cc-hero-916", "cc-feed-43", "cc-feed-11"]);
    assert.deepEqual(byId.get("cc-feed-43")?.dependsOnStageIds, []);
    assert.equal(byId.get("cc-hero-916")?.role, "conceptImage");
    assert.equal(byId.get("cc-feed-11")?.capability, "flux-dev");
    assert.equal(byId.get("cc-feed-11")?.inputSource, "approved-source");
    assert.equal(byId.get("cc-hero-916")?.format, "9:16");
  });

  it("motion stages keep stage-output edges to their keyframe", () => {
    const template = getTemplate("creator-campaign") as ProductionTemplate;
    const built = buildTemplateStages(
      template,
      selection({ packSize: "custom", stageIds: ["cc-motion-916"], assetTypes: ["image", "motion"] }),
      resolveCapability
    );
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const stages = toPlanStages(built.plan, "balanced");
    const motion = stages.find((s) => s.id === "cc-motion-916")!;
    assert.deepEqual(motion.dependsOnStageIds, ["cc-hero-916"]);
    assert.equal(motion.inputSource, "stage-output");
  });

  it("deferred narration/music/subtitle recipes stay deferred, never dispatched", () => {
    const template = getTemplate("real-estate") as ProductionTemplate;
    const built = buildTemplateStages(
      template,
      selection({ packSize: "full", assetTypes: ["image", "motion", "narration", "music", "subtitle"] }),
      resolveCapability
    );
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const deferredIds = built.plan.deferred.map((d) => d.recipe.id);
    assert.ok(deferredIds.includes("re-narration") && deferredIds.includes("re-music") && deferredIds.includes("re-subtitles"));
    assert.ok(built.plan.deferred.every((d) => d.reason.length > 0));
    assert.ok(built.plan.stages.every((s) => s.recipe.execution === "create_media"));
  });
});

describe("5. duration and aspect metadata survive into built stages", () => {
  it("motion carries requested/resolved duration provenance and the length in its label", () => {
    const template = getTemplate("creator-campaign") as ProductionTemplate;
    const built = buildTemplateStages(
      template,
      selection({ packSize: "custom", stageIds: ["cc-motion-916"], assetTypes: ["image", "motion"], motionSeconds: 6 }),
      resolveCapability
    );
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const stages = toPlanStages(built.plan, "balanced");
    const motion = stages.find((s) => s.id === "cc-motion-916")!;
    assert.equal(motion.durationSeconds, 6);
    assert.equal(motion.requestedDurationSeconds, 6);
    assert.equal(motion.durationSource, "product-range-unverified");
    assert.match(motion.label, /6s/);
    assert.equal(motion.format, "9:16");
  });

  it("model rejection fails the build honestly with the stage label", () => {
    const template = getTemplate("creator-campaign") as ProductionTemplate;
    const built = buildTemplateStages(
      template,
      selection({ packSize: "custom", stageIds: ["cc-motion-916"], assetTypes: ["image", "motion"], motionSeconds: 2 }),
      resolveCapability
    );
    assert.equal(built.ok, false);
    if (built.ok) return;
    assert.match(built.error, /Motion asset/);
  });
});

describe("6. estimates unchanged", () => {
  it("rough minutes follow the still/motion/upscale heuristic", () => {
    const template = getTemplate("creator-campaign") as ProductionTemplate;
    const built = buildTemplateStages(template, selection({ packSize: "quick" }), resolveCapability);
    assert.equal(built.ok, true);
    if (!built.ok) return;
    // Quick pick = 3 stills (no motion): 3 × 1.5 = 4.5 minutes exactly.
    const minutes = estimateTemplateMinutes(built.plan);
    assert.equal(minutes, 4.5);
    assert.equal(estimateTemplateMinutes({ stages: [] }), 0);
  });
});
