import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCampaignSelection } from "./campaign-selection";
import type { Database } from "./types";

const TODAY = "2026-09-20";

function db(): Database {
  return {
    creators: [
      { id: "crt_maya", name: "Maya Chen", handle: "@maya" },
      { id: "crt_leo", name: "Leo Okafor", handle: "@leo" }
    ],
    passports: [
      {
        id: "pp_maya",
        creatorId: "crt_maya",
        creatorName: "Maya Chen",
        sourceMediaIds: ["med_maya"],
        platforms: ["instagram"],
        countries: ["GR"],
        allowedTransformations: ["edit"],
        validFrom: "2026-01-01",
        validUntil: "2027-03-01",
        status: "active",
        attestation: { method: "creator-consent-link", consentedAt: "2026-01-01", declaration: "d" },
        visibility: "public"
      },
      {
        id: "pp_leo",
        creatorId: "crt_leo",
        creatorName: "Leo Okafor",
        sourceMediaIds: ["med_leo"],
        platforms: ["tiktok"],
        countries: ["US"],
        allowedTransformations: ["edit"],
        validFrom: "2026-01-01",
        validUntil: "2027-01-31",
        status: "active",
        attestation: { method: "creator-consent-link", consentedAt: "2026-01-01", declaration: "d" },
        visibility: "public"
      }
    ],
    sourceMedia: [
      { id: "med_maya", creatorId: "crt_maya", title: "Maya walk", type: "image", url: "https://x/y.jpg", hash: "h1" },
      { id: "med_leo", creatorId: "crt_leo", title: "Leo unbox", type: "image", url: "https://x/z.jpg", hash: "h2" }
    ],
    productFacts: [
      { id: "pf_verdi", brand: "Verdi Steps", productName: "TerraRunner", approvedClaims: ["a"], prohibitedClaims: [], guidelines: [], evidenceNotes: "e", visibility: "shared" },
      { id: "pf_other", brand: "Other", productName: "Thing", approvedClaims: [], prohibitedClaims: [], guidelines: [], evidenceNotes: "e", visibility: "shared" }
    ],
    campaigns: [],
    consentInvites: [],
    events: [],
    idempotencyKeys: {},
    deletedCampaigns: []
  };
}

const MAYA_PICK = { creatorId: "crt_maya", passportId: "pp_maya", sourceMediaId: "med_maya", productFactsId: "pf_verdi" };

describe("resolveCampaignSelection", () => {
  it("resolves a complete valid selection across multiple creators and products", () => {
    const r = resolveCampaignSelection(db(), MAYA_PICK, TODAY);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.creator.id, "crt_maya");
      assert.equal(r.value.passport.id, "pp_maya");
      assert.equal(r.value.media.id, "med_maya");
      assert.equal(r.value.facts.id, "pf_verdi");
    }
    const leo = resolveCampaignSelection(
      db(),
      { creatorId: "crt_leo", passportId: "pp_leo", sourceMediaId: "med_leo", productFactsId: "pf_other" },
      TODAY
    );
    assert.equal(leo.ok, true);
  });

  it("requires every id - never silently picks the first record", () => {
    for (const sel of [
      {},
      { ...MAYA_PICK, creatorId: undefined },
      { ...MAYA_PICK, passportId: "" },
      { ...MAYA_PICK, sourceMediaId: undefined },
      { ...MAYA_PICK, productFactsId: undefined }
    ]) {
      const r = resolveCampaignSelection(db(), sel, TODAY);
      assert.equal(r.ok, false);
    }
  });

  it("rejects unknown ids", () => {
    const r = resolveCampaignSelection(db(), { ...MAYA_PICK, passportId: "pp_nope" }, TODAY);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /no longer exists/);
  });

  it("rejects cross-creator mismatches", () => {
    const passportMismatch = resolveCampaignSelection(db(), { ...MAYA_PICK, passportId: "pp_leo" }, TODAY);
    assert.equal(passportMismatch.ok, false);

    const mediaMismatch = resolveCampaignSelection(db(), { ...MAYA_PICK, sourceMediaId: "med_leo" }, TODAY);
    assert.equal(mediaMismatch.ok, false);
    if (!mediaMismatch.ok) assert.match(mediaMismatch.error, /different creator/);
  });

  it("rejects revoked and expired permissions", () => {
    const d = db();
    d.passports[0].status = "revoked";
    const revoked = resolveCampaignSelection(d, MAYA_PICK, TODAY);
    assert.equal(revoked.ok, false);
    if (!revoked.ok) assert.match(revoked.error, /not active/);

    const d2 = db();
    d2.passports[0].validUntil = "2026-09-19";
    const expired = resolveCampaignSelection(d2, MAYA_PICK, TODAY);
    assert.equal(expired.ok, false);
    if (!expired.ok) assert.match(expired.error, /expired/);
  });
});
