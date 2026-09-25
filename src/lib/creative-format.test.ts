import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unsupportedCreativeFormatReason } from "./creative-format";

describe("Creative model format guard", () => {
  it("keeps Qwen out of non-square planned placements after a measured mismatch", () => {
    assert.match(unsupportedCreativeFormatReason("qwen-image-3-t2i", "9:16") ?? "", /not reliably delivered/);
    assert.equal(unsupportedCreativeFormatReason("qwen-image-3-t2i", "1:1"), null);
  });

  it("does not restrict other models beyond the API-wide format contract", () => {
    assert.equal(unsupportedCreativeFormatReason("flux-dev", "9:16"), null);
    assert.match(unsupportedCreativeFormatReason("flux-dev", "5:4") ?? "", /not accepted/);
  });
});
