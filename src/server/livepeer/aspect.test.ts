import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aspectVerdict, describeActualSize, ASPECT_TOLERANCE } from "./aspect";

/** Requested-vs-delivered aspect honesty. No network, no DKG, no paid calls. */

describe("aspectVerdict", () => {
  it("matches exact planned frames", () => {
    assert.equal(aspectVerdict("1:1", 1024, 1024), "match");
    assert.equal(aspectVerdict("9:16", 768, 1365), "match");
    assert.equal(aspectVerdict("16:9", 1365, 768), "match");
    assert.equal(aspectVerdict("4:3", 1024, 768), "match");
  });

  it("flags real mismatches — e.g. requested 1:1, received 4:3", () => {
    assert.equal(aspectVerdict("1:1", 1024, 768), "mismatch");
    assert.equal(aspectVerdict("9:16", 1024, 1024), "mismatch");
    assert.equal(aspectVerdict("16:9", 768, 1365), "mismatch");
  });

  it("tolerates small provider rounding but nothing more", () => {
    assert.ok(ASPECT_TOLERANCE <= 0.03, "tolerance stays small");
    assert.equal(aspectVerdict("1:1", 1023, 1024), "match");
    assert.equal(aspectVerdict("1:1", 1000, 1100), "mismatch");
  });

  it("never guesses without measured size or for unknown formats", () => {
    assert.equal(aspectVerdict("1:1", undefined, undefined), "unknown");
    assert.equal(aspectVerdict("1:1", null, null), "unknown");
    assert.equal(aspectVerdict("1:1", 0, 0), "unknown");
    assert.equal(aspectVerdict("3:2", 1024, 683), "unknown");
  });
});

describe("describeActualSize", () => {
  it("names measured pixels and the reduced ratio", () => {
    assert.equal(describeActualSize(1024, 768), "1024×768 · 4:3");
    assert.equal(describeActualSize(1024, 1024), "1024×1024 · 1:1");
    assert.equal(describeActualSize(768, 1365), "768×1365 · 256:455");
  });
});
