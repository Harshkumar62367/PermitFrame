import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DOCUMENTED_MODEL_POLICIES,
  GLOBAL_MAX_SECONDS,
  GLOBAL_MIN_SECONDS,
  lookupDocumentedPolicy,
  resolveMotionDuration,
  validateDurationRequest
} from "./duration-policy";
import { quoteStage, stageSpendingCeiling } from "./pricing";

/** Duration policy: global gate, bucket adjustment, honest rejection. No I/O. */

describe("global duration gate", () => {
  it("accepts 3, 5, 10, 15 and numeric strings", () => {
    for (const v of [3, 5, 10, 15, "8"]) {
      const r = validateDurationRequest(v);
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.seconds, Number(v));
    }
    assert.equal(GLOBAL_MIN_SECONDS, 3);
    assert.equal(GLOBAL_MAX_SECONDS, 15);
  });

  it("rejects out-of-range, fractional, and non-numeric requests without clamping", () => {
    for (const v of [0, 1, 2, 16, 30, 60, -5, 7.5, Number.NaN, "x", undefined, null, {}]) {
      const r = validateDurationRequest(v);
      assert.equal(r.ok, false, `${JSON.stringify(v)} must be rejected`);
      if (!r.ok) assert.match(r.error, /3-15|whole number|must be a number/);
    }
  });
});

describe("model resolution", () => {
  it("passes in-range requests through unadjusted when buckets are unknown", () => {
    for (const seconds of [3, 5, 8, 10, 15]) {
      const r = resolveMotionDuration(seconds, "kling-v3-turbo-i2v");
      assert.equal(r.ok, true);
      if (r.ok) {
        assert.equal(r.resolvedSeconds, seconds);
        assert.equal(r.adjusted, false);
      }
    }
    // Unknown capabilities get the same honest passthrough, never invented limits.
    const unknown = resolveMotionDuration(9, "some-future-model");
    assert.equal(unknown.ok, true);
    if (unknown.ok) assert.equal(unknown.resolvedSeconds, 9);
  });

  it("adjusts to the nearest bucket with the exact reason", () => {
    const meta = { bucketsSeconds: [6, 8, 10], source: "synthetic-test" };
    const r = resolveMotionDuration(7, "kling-v3-turbo-i2v", meta);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.requestedSeconds, 7);
      assert.equal(r.resolvedSeconds, 8);
      assert.equal(r.adjusted, true);
      assert.equal(
        r.adjustmentReason,
        "Adjusted from 7s to 8s because this motion model renders 6s, 8s, or 10s clips."
      );
    }
  });

  it("chooses the higher bucket on equal distance", () => {
    const r = resolveMotionDuration(7, "kling-v3-turbo-i2v", { bucketsSeconds: [6, 8] });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.resolvedSeconds, 8);
    const r2 = resolveMotionDuration(9, "kling-v3-turbo-i2v", { bucketsSeconds: [8, 10] });
    assert.equal(r2.ok, true);
    if (r2.ok) assert.equal(r2.resolvedSeconds, 10);
  });

  it("rejects below-minimum and above-maximum without lowering", () => {
    const meta = { minSeconds: 5, maxSeconds: 10 };
    const low = resolveMotionDuration(3, "kling-v3-turbo-i2v", meta);
    assert.equal(low.ok, false);
    if (!low.ok) assert.match(low.error, /minimum 5s/);
    // A 15s request against a 10s-maximum model is rejected, never cut to 10s.
    const high = resolveMotionDuration(15, "kling-v3-turbo-i2v", meta);
    assert.equal(high.ok, false);
    if (!high.ok) assert.match(high.error, /maximum 10s/);
  });

  it("resolver itself rejects fractional, NaN, and out-of-range values", () => {
    for (const v of [7.5, Number.NaN, 2, 16, 0, -3, "x", undefined, null]) {
      const r = resolveMotionDuration(v as number, "kling-v3-turbo-i2v");
      assert.equal(r.ok, false, `${JSON.stringify(v)} must die in the resolver`);
    }
    // Numeric strings normalize through the same gate.
    const s = resolveMotionDuration("8" as unknown as number, "kling-v3-turbo-i2v");
    assert.equal(s.ok, true);
    if (s.ok) assert.equal(s.resolvedSeconds, 8);
  });

  it("unverified models resolve with honest source, never a support claim", () => {
    for (const cap of ["ltx-25-i2v-fast", "pixverse-i2v", "kling-v3-turbo-i2v", "seedance-i2v", "veo-i2v", "some-future-model"]) {
      const r = resolveMotionDuration(8, cap);
      assert.equal(r.ok, true);
      if (r.ok) {
        assert.equal(r.source, "product-range-unverified");
        assert.equal(r.modelConstraintKnown, false);
        assert.equal(
          r.note,
          "This selected model has no published duration metadata in Livepeer discovery. PermitFrame will request a 8s single clip; provider validation still applies."
        );
      }
    }
  });

  it("no cited model policies exist - nothing claims verified support", () => {
    assert.deepEqual(Object.keys(DOCUMENTED_MODEL_POLICIES), []);
    for (const cap of ["kling-v3-turbo-i2v", "pixverse-i2v", "veo-i2v"]) {
      assert.equal(lookupDocumentedPolicy(cap), undefined);
    }
  });

  it("genuine metadata resolves as provider-aware with confidence", () => {
    const r = resolveMotionDuration(8, "kling-v3-turbo-i2v", { bucketsSeconds: [6, 8, 10], source: "synthetic-test" });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.source, "provider-metadata");
      assert.equal(r.modelConstraintKnown, true);
      assert.equal(r.note, undefined);
      assert.equal(r.adjusted, false);
    }
  });

  it("estimates and ceilings price the resolved length, never the requested one", () => {
    const live = new Map([["pixverse-i2v", { usd: 0.06825, unit: "second", unitKind: "time" }]]);
    const resolved = resolveMotionDuration(7, "pixverse-i2v", { bucketsSeconds: [6, 8, 10] });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) throw new Error("unexpected rejection");
    const quote = quoteStage({ capability: "pixverse-i2v", kind: "image-to-video" }, live, resolved.resolvedSeconds);
    assert.deepEqual(quote, { usd: 0.06825 * 8, exact: true });
    assert.equal(
      stageSpendingCeiling({ capability: "pixverse-i2v", kind: "image-to-video" }, live, resolved.resolvedSeconds),
      Math.round(0.06825 * 8 * 3 * 100) / 100
    );
  });

  it("replacement models re-resolve: bucket adjustment, rejection, repricing", () => {
    const live = new Map([["new-model-i2v", { usd: 0.1, unit: "second", unitKind: "time" }]]);
    // Replacement with buckets: 7s adjusts to 8s, priced at 8s.
    const adjusted = resolveMotionDuration(7, "new-model-i2v", { bucketsSeconds: [6, 8, 10] });
    assert.equal(adjusted.ok, true);
    if (!adjusted.ok) throw new Error("unexpected rejection");
    assert.equal(adjusted.resolvedSeconds, 8);
    assert.equal(adjusted.source, "provider-metadata");
    assert.deepEqual(quoteStage({ capability: "new-model-i2v", kind: "image-to-video" }, live, adjusted.resolvedSeconds), {
      usd: 0.8,
      exact: true
    });
    // Replacement with a 10s maximum rejects a 15s request - never cut down.
    const rejected = resolveMotionDuration(15, "new-model-i2v", { maxSeconds: 10 });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.match(rejected.error, /maximum 10s/);
  });

  it("replacement without metadata claims no verified support", () => {
    const r = resolveMotionDuration(8, "replacement-model-x");
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.source, "product-range-unverified");
      assert.equal(r.modelConstraintKnown, false);
      assert.ok((r.note ?? "").includes("no published duration metadata"));
    }
  });
});
