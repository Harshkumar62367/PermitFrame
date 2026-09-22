import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deliverableKind,
  describeMotionOutputs,
  hasUnknownPrice,
  recommendInitialStages,
  type Deliverable
} from "./studio-model";
import type { ProductionStagePlan } from "@/server/types";

function stage(id: string, kind: string, capability = "flux-schnell"): ProductionStagePlan {
  return { id, label: id, kind, capability, format: "9:16" } as ProductionStagePlan;
}

const FEED: Deliverable = {
  id: "feed",
  title: "Feed creative",
  spec: "1:1",
  platforms: "Instagram",
  stages: [stage("square-variation", "image-to-image")]
};

const VERTICAL: Deliverable = {
  id: "vertical",
  title: "Vertical social",
  spec: "9:16",
  platforms: "Reels / TikTok",
  stages: [stage("keyframe", "text-to-image"), stage("motion", "image-to-video")]
};

const LANDSCAPE: Deliverable = {
  id: "landscape",
  title: "Landscape",
  spec: "16:9",
  platforms: "YouTube / LinkedIn",
  stages: [stage("header-169", "image-to-image")]
};

describe("recommendInitialStages", () => {
  it("picks the platform-matched deliverable's image stages, never video", () => {
    assert.deepEqual(recommendInitialStages("instagram", [VERTICAL, FEED], new Set()), ["square-variation"]);
    assert.deepEqual(recommendInitialStages("tiktok", [VERTICAL, FEED], new Set()), ["keyframe"]);
    assert.deepEqual(
      recommendInitialStages("youtube", [VERTICAL, FEED, LANDSCAPE], new Set()),
      ["header-169"]
    );
  });

  it("skips succeeded stages and falls back across deliverables", () => {
    assert.deepEqual(
      recommendInitialStages("tiktok", [VERTICAL, FEED], new Set(["keyframe"])),
      ["square-variation"]
    );
  });

  it("returns empty when only motion or nothing remains", () => {
    assert.deepEqual(recommendInitialStages("tiktok", [VERTICAL], new Set(["keyframe"])), []);
    assert.deepEqual(recommendInitialStages("instagram", [], new Set()), []);
  });
});

describe("deliverableKind", () => {
  it("distinguishes image, video, and mixed stage lists", () => {
    assert.equal(deliverableKind([stage("a", "text-to-image")]), "image");
    assert.equal(deliverableKind([stage("m", "image-to-video")]), "video");
    assert.equal(
      deliverableKind([stage("a", "text-to-image"), stage("m", "image-to-video")]),
      "mixed"
    );
  });
});

describe("hasUnknownPrice", () => {
  it("flags stages missing from the catalogue price map", () => {
    assert.equal(hasUnknownPrice([stage("a", "text-to-image", "flux-schnell")]), false);
    assert.equal(hasUnknownPrice([stage("a", "text-to-image", "no-such-capability")]), true);
  });
});

describe("describeMotionOutputs", () => {
  it("names separate short clips, never a stitched film", () => {
    assert.equal(describeMotionOutputs([]), "Images");
    assert.equal(describeMotionOutputs([5]), "Images + one short video clip");
    assert.equal(describeMotionOutputs([5, 5]), "Images + 2 separate short clips · 5s each");
    assert.equal(describeMotionOutputs([5, 8]), "Images + 2 separate short clips");
    assert.equal(describeMotionOutputs([null]), "Images + one short video clip");
  });
});
