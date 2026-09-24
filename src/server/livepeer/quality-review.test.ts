import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  QUALITY_NOTE_DISPLAY_MAX,
  deriveQualityReview,
  qualityReviewCopy,
  truncateQualityNote
} from "./quality-review";

/**
 * Quality-review derivation: pure unit tests (no DB, no provider calls -
 * this module imports nothing but shared types).
 */

describe("deriveQualityReview", () => {
  it("derives reviewed only from an explicit pass with a finite score", () => {
    assert.deepEqual(
      deriveQualityReview({ qualityPassed: true, qualityScore: 0.92, qualityNote: "ok" }, null),
      { state: "reviewed", note: null }
    );
  });

  it("never infers a pass from missing critique data", () => {
    assert.deepEqual(deriveQualityReview(undefined, null), { state: "not_assessed", note: null });
    assert.deepEqual(deriveQualityReview(null, null), { state: "not_assessed", note: null });
    assert.deepEqual(deriveQualityReview({}, null), { state: "not_assessed", note: null });
    // A score without an explicit boolean is not a pass.
    assert.deepEqual(
      deriveQualityReview({ qualityScore: 0.95 }, null),
      { state: "not_assessed", note: null }
    );
    // The server's null-score advisory pass (passed:true, no score) proves
    // nothing to a reviewer - it must not read as reviewed.
    assert.deepEqual(
      deriveQualityReview({ qualityPassed: true, qualityNote: "Automated visual check did not return a usable score." }, null),
      { state: "not_assessed", note: null }
    );
    assert.deepEqual(
      deriveQualityReview({ qualityPassed: true, qualityScore: null as unknown as number }, null),
      { state: "not_assessed", note: null }
    );
  });

  it("derives needs_attention with the safe persisted note", () => {
    assert.deepEqual(
      deriveQualityReview({ qualityPassed: false, qualityScore: 0.4, qualityNote: "Subject drift in frame two." }, null),
      { state: "needs_attention", note: "Subject drift in frame two." }
    );
    // Missing note still flags attention without inventing text.
    assert.deepEqual(
      deriveQualityReview({ qualityPassed: false }, null),
      { state: "needs_attention", note: null }
    );
  });

  it("keeps ratio mismatch dominant over any critique outcome", () => {
    const blocked = { aspectVerdict: "mismatch" as const };
    assert.deepEqual(
      deriveQualityReview({ qualityPassed: false, qualityScore: 0.2, qualityNote: "bad" }, blocked),
      { state: "delivery_blocked", note: null }
    );
    assert.deepEqual(
      deriveQualityReview({ qualityPassed: true, qualityScore: 0.99 }, blocked),
      { state: "delivery_blocked", note: null }
    );
    assert.deepEqual(deriveQualityReview(undefined, blocked), { state: "delivery_blocked", note: null });
    // Stored reason form behaves identically.
    assert.deepEqual(
      deriveQualityReview(undefined, { deliveryBlocked: "aspect_ratio_mismatch" as const }),
      { state: "delivery_blocked", note: null }
    );
  });

  it("treats legacy jobs with no quality fields as not_assessed", () => {
    assert.deepEqual(
      deriveQualityReview(
        { qualityPassed: undefined, qualityScore: undefined, qualityNote: undefined },
        { aspectVerdict: "match" as const }
      ),
      { state: "not_assessed", note: null }
    );
    assert.deepEqual(deriveQualityReview(undefined, undefined), { state: "not_assessed", note: null });
  });
});

describe("truncateQualityNote", () => {
  it("caps long notes without leaking internals", () => {
    const long = `Vision verdict: drift detected. ${"detail ".repeat(60)}`;
    const out = truncateQualityNote(long)!;
    assert.ok(out.length <= QUALITY_NOTE_DISPLAY_MAX, `note capped at ${QUALITY_NOTE_DISPLAY_MAX}`);
    assert.ok(out.endsWith("…"));
    assert.ok(out.startsWith("Vision verdict: drift detected."));
  });

  it("returns null for missing or blank notes", () => {
    assert.equal(truncateQualityNote(null), null);
    assert.equal(truncateQualityNote(undefined), null);
    assert.equal(truncateQualityNote(""), null);
    assert.equal(truncateQualityNote("   \n  "), null);
  });

  it("collapses whitespace and passes short notes through", () => {
    assert.equal(truncateQualityNote("  low  light\non  subject "), "low light on subject");
  });
});

describe("qualityReviewCopy", () => {
  it("covers every state with fixed reviewer-safe copy", () => {
    assert.equal(qualityReviewCopy("delivery_blocked"), "Not deliverable - ratio mismatch.");
    assert.equal(qualityReviewCopy("needs_attention"), "Needs attention - the automated check flagged this output.");
    assert.equal(qualityReviewCopy("reviewed"), "Automated review found no issue.");
    assert.equal(
      qualityReviewCopy("not_assessed"),
      "Not assessed automatically - review this asset before delivery."
    );
  });
});
