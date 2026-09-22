import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCustomizeSummary,
  buildSelection,
  computeHasChanges,
  deriveCanApply,
  normalizeSelection,
  recommendedStageIds,
  switchTemplateSelection,
  toggleList,
  validateDuration,
  type DraftSelection
} from "./template-selection";

/** Pure pack-configurator helpers. No network, no DKG, no React. */

const DRAFT: DraftSelection = {
  templateId: "creator-campaign",
  packSize: "campaign",
  assetTypes: ["image", "motion"],
  formats: ["9:16", "4:5", "1:1", "16:9"],
  stageIds: [],
  motionSeconds: 5,
  qualityProfile: "balanced",
  maxSpendCapUsd: undefined
};

describe("computeHasChanges", () => {
  it("treats a legacy campaign without productionSpec as pending (hasChanges=true)", () => {
    assert.equal(computeHasChanges(undefined, DRAFT), true);
  });

  it("reports no changes when the draft matches the persisted spec", () => {
    assert.equal(
      computeHasChanges(
        {
          templateId: "creator-campaign",
          packSize: "campaign",
          assetTypes: ["image", "motion"],
          qualityProfile: "balanced"
        },
        DRAFT
      ),
      false
    );
  });

  it("treats a full format set as equivalent to omitted formats", () => {
    const persisted = {
      templateId: "creator-campaign",
      packSize: "campaign",
      assetTypes: ["motion", "image"],
      formats: ["16:9", "1:1", "4:5", "9:16"],
      qualityProfile: "balanced"
    };
    assert.equal(computeHasChanges(persisted, DRAFT), false);
    assert.equal(
      computeHasChanges(persisted, { ...DRAFT, formats: ["9:16", "1:1"] }),
      true
    );
  });

  it("ignores stage ids for non-custom packs and motion length when motion is off", () => {
    const persisted = {
      templateId: "creator-campaign",
      packSize: "campaign",
      assetTypes: ["image", "motion"],
      qualityProfile: "balanced"
    };
    assert.equal(computeHasChanges(persisted, { ...DRAFT, stageIds: ["stale"] }), false);
    assert.equal(
      computeHasChanges(persisted, { ...DRAFT, assetTypes: ["image"], motionSeconds: 15 }),
      true
    );
  });
});

describe("switchTemplateSelection", () => {
  const next = { id: "product-launch", title: "Product Launch Pack", compatibleProfiles: ["balanced"] };

  it("clears stale custom stage ids on every template switch", () => {
    const switched = switchTemplateSelection("balanced", {
      id: "real-estate",
      title: "Real Estate Pack",
      compatibleProfiles: ["balanced", "premium"]
    });
    assert.deepEqual(switched.stageIds, []);
    assert.equal(switched.templateId, "real-estate");
    assert.equal(switched.profile, "balanced");
    assert.equal(switched.notice, null);
  });

  it("resets an unsupported profile to Balanced with notice", () => {
    const switched = switchTemplateSelection("premium", next);
    assert.deepEqual(switched.stageIds, []);
    assert.equal(switched.profile, "balanced");
    assert.equal(switched.notice, "Product Launch Pack does not support the premium profile - reset to Balanced.");
  });
});

describe("validateDuration + deriveCanApply", () => {
  it("rejects non-integer, too-short, and too-long clip lengths", () => {
    assert.equal(validateDuration(true, null), "Enter a clip length to continue.");
    assert.equal(validateDuration(true, 2), "Whole seconds, 3-15.");
    assert.equal(validateDuration(true, 16), "Whole seconds, 3-15.");
    assert.equal(validateDuration(true, 5.5), "Whole seconds, 3-15.");
    assert.equal(validateDuration(true, 5), null);
    assert.equal(validateDuration(false, null), null);
  });

  it("a duration-invalid draft cannot apply", () => {
    const base = {
      allowed: true,
      applying: false,
      hasPreview: true,
      hasPreviewError: false,
      packSize: "campaign",
      stageIds: [] as string[]
    };
    assert.equal(deriveCanApply({ ...base, durationError: null }), true);
    assert.equal(deriveCanApply({ ...base, durationError: "Whole seconds, 3-15." }), false);
  });

  it("custom packs need at least one stage; missing preview blocks apply", () => {
    const base = {
      allowed: true,
      applying: false,
      hasPreview: true,
      hasPreviewError: false,
      durationError: null
    };
    assert.equal(deriveCanApply({ ...base, packSize: "custom", stageIds: [] }), false);
    assert.equal(deriveCanApply({ ...base, packSize: "custom", stageIds: ["a"] }), true);
    assert.equal(deriveCanApply({ ...base, packSize: "campaign", stageIds: [], hasPreview: false }), false);
  });
});

describe("buildSelection", () => {
  const base = {
    templateId: "creator-campaign",
    packSize: "campaign",
    motionOn: true,
    formats: ["9:16", "4:5", "1:1", "16:9"],
    stageIds: [] as string[],
    motionSeconds: 5,
    durationError: null,
    profile: "balanced",
    cap: ""
  };

  it("omits formats when every format is selected", () => {
    const sel = buildSelection(base);
    assert.ok(!("formats" in sel));
    assert.deepEqual(sel.assetTypes, ["image", "motion"]);
    assert.equal(sel.motionSeconds, 5);
  });

  it("keeps partial formats and drops invalid motion length and empty cap", () => {
    const sel = buildSelection({
      ...base,
      formats: ["9:16"],
      motionSeconds: 99,
      durationError: "Whole seconds, 3-15.",
      cap: ""
    });
    assert.deepEqual(sel.formats, ["9:16"]);
    assert.ok(!("motionSeconds" in sel));
    assert.ok(!("maxSpendCapUsd" in sel));
  });

  it("includes custom stage ids only for custom packs and parses a valid cap", () => {
    assert.deepEqual(buildSelection({ ...base, packSize: "custom", stageIds: ["a"], cap: "12.5" }).stageIds, ["a"]);
    assert.equal(buildSelection({ ...base, packSize: "custom", stageIds: ["a"], cap: "12.5" }).maxSpendCapUsd, 12.5);
    assert.ok(!("stageIds" in buildSelection({ ...base, stageIds: ["a"] })));
  });
});

describe("toggleList + recommendedStageIds + summaries", () => {
  it("toggles while preserving canonical order", () => {
    assert.deepEqual(toggleList(["9:16"], "1:1", ["9:16", "4:5", "1:1", "16:9"]), ["9:16", "1:1"]);
    assert.deepEqual(toggleList(["9:16", "1:1"], "9:16", ["9:16", "4:5", "1:1", "16:9"]), ["1:1"]);
  });

  it("picks executable non-optional recipes and summarizes the draft", () => {
    const template = {
      recipes: [
        { id: "a", execution: "create_media", optional: false },
        { id: "b", execution: "create_media", optional: true },
        { id: "c", execution: "deferred", optional: false }
      ]
    };
    assert.deepEqual(recommendedStageIds(template as never), ["a"]);
    assert.deepEqual(recommendedStageIds(null), []);
    assert.equal(
      buildCustomizeSummary({ motionOn: true, formats: ["9:16", "4:5", "1:1", "16:9"], profile: "balanced", cap: "" }),
      "Images + motion · Recommended formats · Balanced quality · No spend cap"
    );
  });

  it("normalizes persisted values, not display strings", () => {
    const norm = normalizeSelection({ ...DRAFT, assetTypes: ["motion", "image"], maxSpendCapUsd: "10" });
    assert.deepEqual(norm.assetTypes, ["image", "motion"]);
    assert.equal(norm.formats, undefined);
    assert.equal(norm.cap, "10");
  });
});
