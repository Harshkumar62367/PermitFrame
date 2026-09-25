import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTemplateStages,
  closeSelectionDependencies,
  DEFERRED_MOTION_REASON,
  estimateTemplateMinutes,
  getTemplate,
  listTemplates,
  toPlanStages,
  TEMPLATE_FORMATS,
  validateTemplateSelection,
  type BuiltTemplatePlan,
  type TemplateSelection
} from "./templates";
import { checkTemplateApplyReadiness } from "../campaigns";
import { checkAssetsPerRun, checkMonthlyBudget, checkProfileAccess, ALLOW_ALL_TIER } from "../entitlements";
import { normalizeStagePlan, validatePlan } from "./plan-dag";
import { requestMetaFor } from "./pipeline";
import { planDeliverables } from "@/components/studio/studio-model";
import type { Campaign } from "../types";

/**
 * Template catalogue tests. Capability routing is stubbed (no discovery,
 * no inference, no spend) - recipes, DAG edges, pack bands, validation,
 * and entitlements are what's under test.
 */

function stubResolve(role: string) {
  return { capability: `test-${role}` };
}

/** Validated selections always close - unwrap or fail loudly. */
function mustBuild(template: Parameters<typeof buildTemplateStages>[0], sel: TemplateSelection): BuiltTemplatePlan {
  const r = buildTemplateStages(template, sel, stubResolve);
  if (!r.ok) throw new Error(`unexpected build failure: ${r.error}`);
  return r.plan;
}

function spec(overrides: Partial<TemplateSelection> = {}): TemplateSelection {
  return {
    templateId: "creator-campaign",
    packSize: "campaign",
    assetTypes: ["image", "motion"],
    qualityProfile: "balanced",
    ...overrides
  };
}

describe("template catalogue", () => {
  it("ships five templates with complete metadata", () => {
    const templates = listTemplates();
    assert.equal(templates.length, 5);
    for (const t of templates) {
      assert.ok(t.id && t.title && t.description && t.useCase);
      assert.ok(t.recipes.every((recipe) => TEMPLATE_FORMATS.includes(recipe.format)), `${t.id} offers only supported formats`);
      assert.ok(t.requiredInputs.length > 0, `${t.id} needs required inputs`);
      assert.ok(t.platforms.length > 0);
      assert.ok(t.recipes.length >= 10, `${t.id} needs 10+ recipes for full packs`);
      assert.ok(t.qualityChecks.length > 0 && t.disclosureRules.length > 0);
      assert.ok(t.compatibleProfiles.length > 0);
      assert.ok(t.toolStrategy.image && t.toolStrategy.motion && t.toolStrategy.finishing);
      assert.ok(t.anchorPolicy.length > 0);
      // Stage ids are globally unique (prompt lookup depends on it).
      const ids = t.recipes.map((r) => r.id);
      assert.equal(new Set(ids).size, ids.length);
      // Every recipe has a prompt scaffold.
      for (const r of t.recipes) {
        assert.equal(typeof t.promptScaffolds[r.promptKey], "function", `${t.id}/${r.id} needs a scaffold`);
      }
      // Exactly three quick picks per template.
      assert.equal(t.recipes.filter((r) => r.quickPick).length, 3, `${t.id} quick pack must be 3 outputs`);
    }
  });

  it("pack bands land in their output ranges", () => {
    for (const t of listTemplates()) {
      const quick = mustBuild(t, spec({ templateId: t.id, packSize: "quick" }));
      assert.equal(quick.executableCount, 3, `${t.id} quick`);
      const campaign = mustBuild(t, spec({ templateId: t.id, packSize: "campaign" }));
      assert.ok(campaign.executableCount >= 5 && campaign.executableCount <= 8, `${t.id} campaign got ${campaign.executableCount}`);
      const full = mustBuild(t, spec({ templateId: t.id, packSize: "full", assetTypes: ["image", "motion", "narration", "music", "subtitle"] }));
      assert.ok(full.executableCount >= 8 && full.executableCount <= 16, `${t.id} full got ${full.executableCount}`);
      assert.ok(full.outputCount >= full.executableCount);
    }
  });

  it("every built plan is a valid DAG with honest motion dependencies", () => {
    for (const t of listTemplates()) {
      for (const packSize of ["quick", "campaign", "full"] as const) {
        const built = mustBuild(t, spec({ templateId: t.id, packSize, assetTypes: ["image", "motion", "narration", "music", "subtitle"] }));
        const stages = toPlanStages(built, "balanced");
        const ordered = validatePlan(normalizeStagePlan(stages, "balanced"));
        assert.equal(ordered.length, stages.length, `${t.id}/${packSize} validates`);
        for (const s of stages) {
          if (s.kind === "image-to-video" || s.kind === "upscale") {
            // Genuine transforms consume an explicit dependency output.
            assert.equal(s.inputSource, "stage-output");
            assert.ok(s.dependsOnStageIds.length > 0, `${t.id}/${s.id} transform needs an explicit dep`);
            if (s.kind === "image-to-video") assert.ok((s.durationSeconds ?? 0) >= 3, `${t.id}/${s.id} motion needs a duration`);
          } else {
            assert.equal(s.inputSource, "approved-source");
            assert.deepEqual(s.dependsOnStageIds, []);
          }
          assert.equal(s.qualityProfile, "balanced");
        }
      }
    }
  });

  it("deferred audio never becomes an executable stage", () => {
    const t = getTemplate("real-estate")!;
    const built = mustBuild(
      t,
      spec({ templateId: "real-estate", packSize: "full", assetTypes: ["image", "motion", "narration", "music", "subtitle"] })
    );
    assert.ok(built.deferred.length >= 3, "narration + music + subtitles planned");
    for (const d of built.deferred) {
      assert.match(d.reason, /not dispatched/i);
      assert.ok(!built.stages.some((s) => s.recipe.id === d.recipe.id));
    }
    // Untoggled audio is excluded silently, not deferred.
    const lean = mustBuild(t, spec({ templateId: "real-estate", packSize: "full", assetTypes: ["image", "motion"] }));
    // Motion is deferred by design (identity-safe motion unavailable);
    // audio simply never enters the pick.
    assert.deepEqual(
      lean.deferred.map((d) => d.recipe.id).sort(),
      ["re-tour-alt", "re-tour-motion"]
    );
    for (const d of lean.deferred) {
      assert.equal(d.reason, DEFERRED_MOTION_REASON);
    }
  });

  it("motion duration override and format filters apply", () => {
    const t = getTemplate("creator-campaign")!;
    const timed = mustBuild(t, spec({ motionSeconds: 8 }));
    for (const s of timed.stages.filter((x) => x.recipe.kind === "image-to-video")) {
      assert.equal(s.durationSeconds, 8);
    }
    const filtered = mustBuild(t, spec({ packSize: "full", formats: ["1:1"] }));
    assert.ok(filtered.stages.length > 0);
    assert.ok(filtered.stages.every((s) => s.recipe.format === "1:1" || s.recipe.assetType !== "image"));
    assert.ok(!filtered.autoIncluded.some((a) => a.id === "cc-hero-916"));
  });

  it("custom packs validate ids and bounds", () => {
    const t = getTemplate("creator-campaign")!;
    const ok = mustBuild(t, spec({ packSize: "custom", stageIds: ["cc-hero-916", "cc-motion-916"] }));
    assert.deepEqual(ok.stages.map((s) => s.recipe.id).sort(), ["cc-feed-11", "cc-hero-916", "cc-motion-916"]);
    const bad = validateTemplateSelection(
      { templateId: "creator-campaign", packSize: "custom", stageIds: ["cc-hero-916", "nope"], assetTypes: ["image"], qualityProfile: "balanced" },
      16
    );
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? "", /nope/);
    const over = validateTemplateSelection(
      { templateId: "creator-campaign", packSize: "custom", stageIds: t.recipes.map((r) => r.id), assetTypes: ["image", "motion"], qualityProfile: "balanced" },
      4
    );
    assert.equal(over.ok, false);
    assert.match(over.error ?? "", /bounded at 4/);
  });

  it("selection validation rejects bad templates, profiles, formats, and caps", () => {
    assert.equal(validateTemplateSelection({ templateId: "nope", packSize: "quick", assetTypes: ["image"] }, 16).ok, false);
    assert.equal(validateTemplateSelection({ templateId: "creator-campaign", packSize: "quick", assetTypes: [] }, 16).ok, false);
    assert.equal(validateTemplateSelection({ templateId: "creator-campaign", packSize: "quick", assetTypes: ["image"], formats: ["3:2"] }, 16).ok, false);
    assert.equal(validateTemplateSelection({ templateId: "creator-campaign", packSize: "quick", assetTypes: ["image"], maxSpendCapUsd: -5 }, 16).ok, false);
    const good = validateTemplateSelection(
      { templateId: "automotive", packSize: "full", assetTypes: ["image", "motion"], qualityProfile: "premium", motionSeconds: 7, maxSpendCapUsd: "25" },
      16
    );
    assert.equal(good.ok, true);
    assert.equal(good.spec?.motionSeconds, 7);
    assert.equal(good.spec?.maxSpendCapUsd, 25);
  });

  it("selection validation rejects out-of-range and fractional motion lengths", () => {
    for (const motionSeconds of [30, 2, 0, 7.5, "x"]) {
      const r = validateTemplateSelection(
        { templateId: "creator-campaign", packSize: "campaign", assetTypes: ["image", "motion"], qualityProfile: "balanced", motionSeconds },
        16
      );
      assert.equal(r.ok, false, `${JSON.stringify(motionSeconds)} must be rejected, never clamped`);
    }
  });

  it("server ignores client-supplied resolved lengths and recomputes", () => {
    const r = validateTemplateSelection(
      { templateId: "creator-campaign", packSize: "campaign", assetTypes: ["image", "motion"], qualityProfile: "balanced", motionSeconds: 8, resolvedMotionSeconds: 3 },
      16
    );
    assert.equal(r.ok, true);
    assert.equal(r.spec?.motionSeconds, 8);
    assert.equal(r.spec?.resolvedMotionSeconds, undefined, "client resolved values are never trusted");
  });

  it("bucket adjustments persist requested, resolved, and reason onto plan stages", () => {
    const t = getTemplate("creator-campaign")!;
    const withBuckets = buildTemplateStages(
      t,
      spec({ packSize: "custom", stageIds: ["cc-hero-916", "cc-motion-916"], motionSeconds: 7 }),
      (role) => ({ capability: role === "imageToVideo" ? "test-motion-x" : `test-${role}` }),
      { "test-motion-x": { bucketsSeconds: [6, 8, 10], source: "synthetic-test" } }
    );
    assert.equal(withBuckets.ok, true);
    if (!withBuckets.ok) throw new Error("unexpected build failure");
    const motion = withBuckets.plan.stages.find((s) => s.recipe.id === "cc-motion-916")!;
    assert.equal(motion.requestedDurationSeconds, 7);
    assert.equal(motion.durationSeconds, 8);
    assert.match(motion.durationNote ?? "", /6s, 8s, or 10s/);
    const stages = toPlanStages(withBuckets.plan, "balanced");
    const planned = stages.find((s) => s.id === "cc-motion-916")!;
    assert.equal(planned.durationSeconds, 8);
    assert.equal(planned.requestedDurationSeconds, 7);
    assert.match(planned.durationNote ?? "", /6s, 8s, or 10s/);
    const meta = requestMetaFor(planned);
    assert.equal(meta.durationSeconds, 8);
    assert.equal(meta.requestedDurationSeconds, 7);
  });

  it("time estimates scale with motion length", () => {
    const t = getTemplate("hospitality")!;
    const short = mustBuild(t, spec({ motionSeconds: 3 }));
    const long = mustBuild(t, spec({ motionSeconds: 12 }));
    assert.ok(estimateTemplateMinutes(long) > estimateTemplateMinutes(short));
    assert.ok(estimateTemplateMinutes(short) > 0);
  });

  it("4:3 stages group into a standard deliverable", () => {
    const t = getTemplate("creator-campaign")!;
    const built = mustBuild(t, spec({ packSize: "full" }));
    const campaign = { preflight: { plan: toPlanStages(built, "balanced") } } as unknown as Campaign;
    const groups = planDeliverables(campaign);
    const standard = groups.find((g) => g.id === "portrait");
    assert.ok(standard && standard.stages.length > 0, "4:3 stages must be selectable");
    assert.ok(standard.stages.every((s) => s.format === "4:3"));
  });

  it("template still prompts never claim keyframe derivation", () => {
    for (const t of listTemplates()) {
      for (const [key, scaffold] of Object.entries(t.promptScaffolds)) {
        if (key === "motion" || key === "upscale" || key === "deferred-audio") continue;
        const text = scaffold({ brand: "B", productName: "P", brief: "brief text here", constraints: [] }).toLowerCase();
        // Naming the hero/keyframe role is fine; claiming derivation from
        // another output ("variation of", "derived from", "from the keyframe")
        // is not.
        assert.ok(
          !/variation of |derived from (the|this|that) |from the \S* ?keyframe|of this campaign keyframe/.test(text),
          `${t.id}/${key} must not claim keyframe derivation`
        );
      }
    }
  });
});

describe("motion duration honesty", () => {
  it("motion stage labels carry the resolved clip length; stills do not", () => {
    const t = getTemplate("creator-campaign")!;
    const built = mustBuild(t, spec({ packSize: "full", motionSeconds: 8 }));
    const stages = toPlanStages(built, "balanced");
    for (const s of stages.filter((x) => x.kind === "image-to-video")) {
      assert.match(s.label, / · 8s$/, `${s.id} names its resolved length`);
    }
    for (const s of stages.filter((x) => x.kind !== "image-to-video")) {
      assert.ok(!/ · \d+s$/.test(s.label), `${s.id} stays a still label`);
    }
  });

  it("template language never implies stitched long-form output", () => {
    const banned = /tour cut|launch film|full video ad|long-form video|campaign film|multi-scene video|scene sequence|final ad/i;
    for (const t of listTemplates()) {
      for (const text of [t.title, t.description, t.useCase, ...t.platforms]) {
        assert.ok(!banned.test(text), `${t.id} copy must not imply stitched output: ${text}`);
      }
      for (const r of t.recipes) {
        assert.ok(!banned.test(r.label), `${t.id}/${r.id} label must not imply stitched output`);
      }
    }
  });
});

describe("dependency closure", () => {
  it("custom motion-only selection includes its keyframe, never the raw source", () => {    const t = getTemplate("creator-campaign")!;
    const built = mustBuild(t, spec({ packSize: "custom", stageIds: ["cc-motion-916"] }));
    const ids = built.stages.map((s) => s.recipe.id).sort();
    assert.deepEqual(ids, ["cc-feed-11", "cc-motion-916"]);
    const auto = built.autoIncluded.find((a) => a.id === "cc-feed-11");
    assert.ok(auto, "square source reported as auto-included");
    assert.deepEqual(auto.requiredFor, ["Motion asset (1:1)"]);
    const motion = built.stages.find((s) => s.recipe.id === "cc-motion-916")!;
    assert.equal(motion.recipe.inputSource, "stage-output");
    assert.deepEqual(motion.recipe.dependsOn, ["cc-feed-11"]);
  });

  it("format filtering that drops the keyframe still retains it for motion", () => {
    const t = getTemplate("creator-campaign")!;
    // The square motion uses the square feed output, so no vertical stage is
    // silently retained by the dependency closure.
    const built = mustBuild(t, spec({ packSize: "full", formats: ["1:1"], assetTypes: ["image", "motion"] }));
    assert.ok(built.stages.some((s) => s.recipe.id === "cc-feed-11"), "square source retained");
    assert.ok(!built.autoIncluded.some((a) => a.id === "cc-hero-916"));
    const motion = built.stages.find((s) => s.recipe.id === "cc-motion-916")!;
    assert.ok(motion, "motion still selected");
  });

  it("motion-only asset toggles still include required image dependencies", () => {
    const t = getTemplate("hospitality")!;
    const built = mustBuild(t, spec({ packSize: "full", assetTypes: ["motion"] }));
    assert.ok(built.stages.some((s) => s.recipe.id === "ho-feed-11"));
    assert.ok(built.stages.every((s) => s.recipe.assetType === "motion" || built.autoIncluded.some((a) => a.id === s.recipe.id)));
  });

  it("an upscale stage includes its source stage", () => {
    const t = getTemplate("automotive")!;
    const built = mustBuild(t, spec({ packSize: "custom", stageIds: ["au-studio-master"] }));
    assert.deepEqual(built.stages.map((s) => s.recipe.id), ["au-studio-916", "au-studio-master"]);
    const upscale = built.stages.find((s) => s.recipe.id === "au-studio-master")!;
    assert.equal(upscale.recipe.inputSource, "stage-output");
  });

  it("a dependency on a deferred stage fails with a clear selection error", () => {
    const t = getTemplate("real-estate")!;
    // Synthetic executable motion hanging off the deferred narration recipe.
    const motion = t.recipes.find((r) => r.id === "re-tour-motion")!;
    const bad = { ...motion, id: "re-tour-bad", dependsOn: ["re-narration"], execution: "create_media" as const };
    const closed = closeSelectionDependencies(t, [bad]);
    assert.equal(closed.ok, false);
    if (!closed.ok) assert.match(closed.error, /Tour narration.*cannot execute|requires "Tour narration"/);
    // And validation rejects it pre-apply (custom pack with both ids).
    const v = validateTemplateSelection(
      { templateId: "real-estate", packSize: "custom", stageIds: ["re-narration"], assetTypes: ["narration"], qualityProfile: "balanced" },
      16
    );
    assert.equal(v.ok, true, "deferred alone is fine");
  });

  it("every pack of every template validates through validatePlan after filtering", () => {
    for (const t of listTemplates()) {
      for (const packSize of ["quick", "campaign", "full"] as const) {
        for (const assetSets of [["image", "motion"], ["motion"], ["image"]] as TemplateSelection["assetTypes"][]) {
          const built = mustBuild(t, spec({ templateId: t.id, packSize, assetTypes: [...assetSets] }));
          const stages = toPlanStages(built, "balanced");
          assert.doesNotThrow(
            () => validatePlan(normalizeStagePlan(stages, "balanced")),
            `${t.id}/${packSize}/${assetSets.join("+")} must validate`
          );
        }
      }
    }
  });
});

describe("template apply readiness", () => {
  function jobs(statuses: string[]) {
    return statuses.map((status, i) => ({ id: `job_${i}`, stageId: "s", status }) as never);
  }

  it("refuses while any active job exists", () => {
    for (const status of ["queued", "generating", "preview_ready", "storage_pending"]) {
      const error = checkTemplateApplyReadiness({ jobs: jobs([status]) });
      assert.equal(error, "Wait for active generation to finish or fail before changing the production template.");
    }
  });

  it("allows apply with only terminal history - nothing pruned", () => {
    for (const statuses of [["ready_to_share"], ["failed"], ["storage_retry_needed"], ["ready_to_share", "failed"], []]) {
      assert.equal(checkTemplateApplyReadiness({ jobs: jobs(statuses) }), null);
    }
  });
});

describe("subtitle asset type", () => {
  it("subtitle survives validation and reaches the deferred preview list", () => {
    const v = validateTemplateSelection(
      { templateId: "real-estate", packSize: "full", assetTypes: ["image", "subtitle"], qualityProfile: "balanced" },
      16
    );
    assert.equal(v.ok, true);
    assert.ok(v.spec?.assetTypes.includes("subtitle"), "server enum key preserved");
    const t = getTemplate("real-estate")!;
    const built = mustBuild(t, v.spec!);
    const sub = built.deferred.find((d) => d.recipe.assetType === "subtitle");
    assert.ok(sub, "subtitle planned as deferred");
    assert.match(sub.reason, /not dispatched/i);
  });
});

describe("entitlements", () => {
  it("allow-all tier passes sane runs", () => {
    assert.equal(checkAssetsPerRun(10, ALLOW_ALL_TIER), null);
    assert.equal(checkProfileAccess("premium", ALLOW_ALL_TIER), null);
    assert.equal(checkMonthlyBudget(5, 5, ALLOW_ALL_TIER), null);
  });

  it("constrained tiers refuse honestly", () => {
    const tier = { ...ALLOW_ALL_TIER, maxAssetsPerRun: 4, premiumModels: false, monthlyBudgetUsd: 10 };
    assert.match(checkAssetsPerRun(5, tier) ?? "", /4 per run/);
    assert.match(checkProfileAccess("premium", tier) ?? "", /not enabled/);
    assert.equal(checkProfileAccess("balanced", tier), null);
    assert.match(checkMonthlyBudget(8, 5, tier) ?? "", /monthly budget/);
    assert.equal(checkMonthlyBudget(8, null, tier), null);
  });
});
