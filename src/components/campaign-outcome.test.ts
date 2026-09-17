import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { campaignOutcome, isPublicRecord } from "./campaign-outcome";

describe("isPublicRecord", () => {
  it("requires explicit anchored state plus a real reference", () => {
    assert.equal(isPublicRecord({ publicationStatus: "anchored", campaignUAL: "did:dkg:0xabc/123" }), true);
  });

  it("never guesses from ID shape", () => {
    // network-looking ID without anchored state is not public
    assert.equal(isPublicRecord({ publicationStatus: "shared", campaignUAL: "did:dkg:0xabc/123" }), false);
    assert.equal(isPublicRecord({ publicationStatus: undefined, campaignUAL: "did:dkg:0xabc/123" }), false);
    assert.equal(isPublicRecord({ publicationStatus: null, campaignUAL: "did:dkg:0xabc/123" }), false);
    // anchored state without any reference is not public either
    assert.equal(isPublicRecord({ publicationStatus: "anchored", campaignUAL: null }), false);
    assert.equal(isPublicRecord({ publicationStatus: "anchored" }), false);
  });

  it("treats local-looking IDs on anchored records as public", () => {
    assert.equal(isPublicRecord({ publicationStatus: "anchored", campaignUAL: "did:dkg:local/abc" }), true);
  });

  it("failed and local states are never public", () => {
    assert.equal(isPublicRecord({ publicationStatus: "failed", campaignUAL: "did:dkg:0xabc/123" }), false);
    assert.equal(isPublicRecord({ publicationStatus: "local", campaignUAL: "did:dkg:local/abc" }), false);
  });
});

describe("campaignOutcome", () => {
  const base = { status: "draft", decision: "allow" as const, hasOutputs: false };

  it("labels local records as saved, never public", () => {
    const o = campaignOutcome({ ...base, status: "approved", publicationStatus: "local", campaignUAL: "did:dkg:local/abc" });
    assert.equal(o.label, "Campaign record saved");
  });

  it("labels shared records as saved, never public", () => {
    const o = campaignOutcome({ ...base, status: "approved", publicationStatus: "shared", campaignUAL: "did:dkg:0xabc/123" });
    assert.equal(o.label, "Campaign record saved");
  });

  it("labels genuinely anchored records as public", () => {
    const o = campaignOutcome({ ...base, status: "approved", publicationStatus: "anchored", campaignUAL: "did:dkg:0xabc/123" });
    assert.equal(o.label, "Public verification ready");
    assert.match(o.explanation ?? "", /tamper-evident/);
  });

  it("labels anchored state without a reference as saved, not public", () => {
    const o = campaignOutcome({ ...base, status: "approved", publicationStatus: "anchored", campaignUAL: null });
    assert.equal(o.label, "Campaign record saved");
  });

  it("treats legacy rows (no status) as non-public", () => {
    const legacy = campaignOutcome({ ...base, status: "approved", campaignUAL: "did:dkg:0xabc/123" });
    assert.equal(legacy.label, "Campaign record saved");
    const failed = campaignOutcome({ ...base, status: "approved", publicationStatus: "failed", campaignUAL: null });
    assert.equal(failed.label, "Campaign record saved");
  });

  it("keeps the pre-output lifecycle intact", () => {
    assert.equal(campaignOutcome({ status: "draft", decision: null, hasOutputs: false }).label, "Ready for permission check");
    assert.equal(campaignOutcome({ status: "draft", decision: "pending", hasOutputs: false }).label, "Ready for permission check");
    assert.equal(campaignOutcome({ status: "blocked", decision: "block", hasOutputs: false }).label, "Changes needed before creation");
    const approved = campaignOutcome({ ...base });
    assert.equal(approved.label, "Approved to create");
    assert.match(approved.explanation ?? "", /Creator permissions and brand rules/);
    assert.equal(campaignOutcome({ ...base, hasOutputs: true }).label, "Asset created");
  });
});
