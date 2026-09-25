import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEMO_BOUNDARY_NOTICE,
  DEMO_CAMPAIGNS,
  DEMO_NO_EVIDENCE_LABEL,
  DEMO_ONLY_LABEL,
  DEMO_READONLY_LABEL,
  demoPrefillFor,
  getDemoCampaign
} from "./demo-campaigns";

/**
 * Demo gallery safety contract. The gallery must stay a read-only
 * walkthrough: exact card set, required honesty labels, no unsupported
 * formats, and a "Use this brief" payload limited to the allow-listed
 * brief fields. Pure - no session, no network, no providers.
 */

const SUPPORTED_RATIOS = ["16:9", "4:3", "1:1", "9:16"];
const PREFILL_KEYS = ["title", "brief", "platform", "suggestedTemplate", "suggestedFormats"];
const PLATFORMS = ["instagram", "tiktok", "youtube", "linkedin"];

describe("demo campaign set", () => {
  it("contains exactly the three specified walkthroughs", () => {
    assert.deepEqual(
      DEMO_CAMPAIGNS.map((d) => d.id),
      ["premium-listing-launch", "creator-sneaker-launch", "skincare-launch"]
    );
    assert.deepEqual(
      DEMO_CAMPAIGNS.map((d) => d.title),
      [
        "Premium residential listing launch",
        "Creator-approved sneaker launch",
        "Sustainable skincare launch"
      ]
    );
  });

  it("uses only supported formats with placements, and never 4:5", () => {
    const dump = JSON.stringify(DEMO_CAMPAIGNS);
    assert.ok(!dump.includes("4:5"), "unsupported 4:5 must not appear anywhere in demo data");
    for (const demo of DEMO_CAMPAIGNS) {
      assert.ok(demo.formats.length > 0, `${demo.id} needs formats`);
      for (const format of demo.formats) {
        assert.ok(SUPPORTED_RATIOS.includes(format.ratio), `${demo.id} uses supported ${format.ratio}`);
        assert.ok(format.placement.trim().length > 0, `${demo.id} explains each placement`);
      }
    }
    assert.deepEqual(
      DEMO_CAMPAIGNS.find((d) => d.id === "premium-listing-launch")?.formats.map((f) => f.ratio),
      ["16:9", "4:3"]
    );
    assert.deepEqual(
      DEMO_CAMPAIGNS.find((d) => d.id === "creator-sneaker-launch")?.formats.map((f) => f.ratio),
      ["9:16", "1:1", "4:3"]
    );
    assert.deepEqual(
      DEMO_CAMPAIGNS.find((d) => d.id === "skincare-launch")?.formats.map((f) => f.ratio),
      ["1:1", "4:3", "16:9"]
    );
  });

  it("states the identity-safe motion limit verbatim on the listing card", () => {
    assert.equal(
      DEMO_CAMPAIGNS.find((d) => d.id === "premium-listing-launch")?.motionNote,
      "Planned — identity-safe property motion is not available for dispatch yet."
    );
  });

  it("requires honesty labels, inputs, checks, and workflow on every card", () => {
    assert.equal(DEMO_ONLY_LABEL, "Demo for hackathon evaluation only");
    assert.equal(DEMO_READONLY_LABEL, "Read-only");
    assert.equal(DEMO_NO_EVIDENCE_LABEL, "No generation, evidence, or proof exists for this demo.");
    assert.equal(
      DEMO_BOUNDARY_NOTICE,
      "You will still need to choose a creator permission, approved media, and a brand rule, then pass the permission check before production."
    );
    for (const demo of DEMO_CAMPAIGNS) {
      assert.ok(demo.tagline.trim().length > 0, `${demo.id} needs a tagline`);
      assert.ok(demo.workflow.length >= 3, `${demo.id} explains the workflow`);
      assert.ok(demo.requiredInputs.length > 0, `${demo.id} lists required inputs`);
      assert.ok(demo.preSpendChecks.length > 0, `${demo.id} lists pre-spend checks`);
    }
  });
});

describe("use-this-brief boundary", () => {
  it("carries only the allow-listed brief fields - never creator, media, or proof data", () => {
    for (const demo of DEMO_CAMPAIGNS) {
      const prefill = demoPrefillFor(demo.id);
      assert.ok(prefill, `${demo.id} resolves a prefill`);
      assert.deepEqual(Object.keys(prefill ?? {}).sort(), [...PREFILL_KEYS].sort());
      // Boundary beyond keys: no URLs, DKG locators, verification refs, or
      // workspace record ids may hide inside the brief text.
      const dump = JSON.stringify(prefill);
      for (const banned of ["http", "did:", "vrf_", "cmp_", "crt_", "media_", "passport", "receipt"]) {
        assert.ok(!dump.toLowerCase().includes(banned), `${demo.id} prefill must not carry ${banned}`);
      }
      assert.ok(PLATFORMS.includes(prefill?.platform ?? ""), `${demo.id} suggests a real platform`);
      assert.ok((prefill?.suggestedTemplate ?? "").trim().length > 0, `${demo.id} suggests a template`);
      assert.ok((prefill?.suggestedFormats.length ?? 0) > 0, `${demo.id} suggests formats`);
    }
  });

  it("returns null for unknown ids so bad links fail closed", () => {
    assert.equal(getDemoCampaign("nope"), undefined);
    assert.equal(demoPrefillFor("nope"), null);
    assert.equal(demoPrefillFor(""), null);
  });
});
