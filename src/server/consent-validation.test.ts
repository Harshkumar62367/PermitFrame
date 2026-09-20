import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateAttestation } from "./consent-validation";
import type { ConsentDraft } from "./types";

const DRAFT: ConsentDraft = {
  creatorId: "creator_maya",
  platforms: ["instagram", "youtube"],
  countries: ["GR", "US"],
  allowedTransformations: ["edit", "animate", "crop", "upscale"],
  validUntil: "2027-03-01",
  sourceMediaIds: ["media_maya_01"]
};

const VALID = {
  platforms: ["instagram"],
  countries: ["GR"],
  allowedTransformations: ["edit", "crop"],
  validUntil: "2027-06-01"
};

describe("validateAttestation", () => {
  it("accepts a narrowed subset with a future expiry", () => {
    const r = validateAttestation(VALID, DRAFT, "2026-09-20");
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.value.platforms, ["instagram"]);
      assert.deepEqual(r.value.countries, ["GR"]);
      assert.equal(r.value.validUntil, "2027-06-01");
    }
  });

  it("normalizes case but rejects widening beyond the draft offer", () => {
    const narrowed = validateAttestation(
      { ...VALID, platforms: ["Instagram"], countries: ["gr"] },
      DRAFT,
      "2026-09-20"
    );
    assert.equal(narrowed.ok, true);

    const platformWidened = validateAttestation({ ...VALID, platforms: ["tiktok"] }, DRAFT, "2026-09-20");
    assert.equal(platformWidened.ok, false);
    if (!platformWidened.ok) assert.match(platformWidened.error, /narrow/i);

    const countryWidened = validateAttestation({ ...VALID, countries: ["DE"] }, DRAFT, "2026-09-20");
    assert.equal(countryWidened.ok, false);
    if (!countryWidened.ok) assert.match(countryWidened.error, /narrow/i);

    const narrowDraft: ConsentDraft = { ...DRAFT, allowedTransformations: ["edit"] };
    const transformWidened = validateAttestation(
      { ...VALID, allowedTransformations: ["edit", "crop"] },
      narrowDraft,
      "2026-09-20"
    );
    assert.equal(transformWidened.ok, false);
    if (!transformWidened.ok) assert.match(transformWidened.error, /narrow/i);
  });

  it("rejects unknown platforms, bad country codes, and empty selections", () => {
    for (const body of [
      { ...VALID, platforms: ["myspace"] },
      { ...VALID, platforms: [] },
      { ...VALID, countries: ["Greece"] },
      { ...VALID, countries: [] },
      { ...VALID, allowedTransformations: "edit" },
      { ...VALID, allowedTransformations: ["teleport"] }
    ]) {
      assert.equal(validateAttestation(body, DRAFT, "2026-09-20").ok, false);
    }
  });

  it("rejects malformed and non-future expiry dates", () => {
    for (const validUntil of ["20-09-2027", "2027/09/01", "2026-09-20", "2025-01-01", ""]) {
      const r = validateAttestation({ ...VALID, validUntil }, DRAFT, "2026-09-20");
      assert.equal(r.ok, false);
    }
  });
});
