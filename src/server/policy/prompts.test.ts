import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { composeStagePrompt } from "./engine";
import type { Campaign } from "../types";

/** Strict per-format shape discipline in dispatched prompts. No live calls. */

function campaignWithPlan(formats: Record<string, string>): Campaign {
  return {
    brand: "Test",
    productName: "Widget",
    request: { creativeBrief: "A product shot at golden hour." },
    preflight: {
      plan: Object.entries(formats).map(([id, format]) => ({ id, format })),
      promptConstraints: []
    }
  } as unknown as Campaign;
}

describe("composeStagePrompt aspect strictness", () => {
  const campaign = campaignWithPlan({
    keyframe: "9:16",
    "square-variation": "1:1",
    "header-169": "16:9",
    motion: "9:16"
  });

  it("insists on vertical 9:16 for the keyframe", () => {
    const prompt = composeStagePrompt(campaign, "keyframe");
    assert.ok(prompt.includes("Strict output shape: vertical 9:16 portrait"));
    assert.ok(prompt.includes("no letterboxing"));
  });

  it("insists on an exact 1:1 square for the feed variation", () => {
    const prompt = composeStagePrompt(campaign, "square-variation");
    assert.ok(prompt.includes("Strict output shape: exact 1:1 square"));
    assert.ok(prompt.includes("no bars"));
  });

  it("insists on wide 16:9 for the header", () => {
    const prompt = composeStagePrompt(campaign, "header-169");
    assert.ok(prompt.includes("Strict output shape: wide 16:9 landscape"));
  });

  it("covers motion stages from the plan format", () => {
    const prompt = composeStagePrompt(campaign, "motion");
    assert.ok(prompt.includes("Strict output shape: vertical 9:16 portrait"));
  });

  it("adds no shape directive when the plan carries no format", () => {
    const prompt = composeStagePrompt(campaignWithPlan({}), "mystery-stage");
    assert.ok(!prompt.includes("Strict output shape"));
  });
});
