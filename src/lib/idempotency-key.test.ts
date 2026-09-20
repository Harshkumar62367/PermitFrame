import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stableAttemptKey } from "./idempotency-key";

describe("stableAttemptKey", () => {
  it("mints a key for the first submission", () => {
    const attempt = stableAttemptKey(null, '{"a":1}', () => "key-1");
    assert.equal(attempt.key, "key-1");
    assert.equal(attempt.payload, '{"a":1}');
  });

  it("reuses the key while the payload is byte-identical (the retry case)", () => {
    const first = stableAttemptKey(null, '{"a":1}', () => "key-1");
    let minted = 0;
    const retry = stableAttemptKey(first, '{"a":1}', () => `key-${++minted}`);
    assert.equal(retry.key, "key-1");
    assert.equal(minted, 0);
  });

  it("mints a fresh key on any edit (intentional new submission)", () => {
    const first = stableAttemptKey(null, '{"a":1}', () => "key-1");
    const edited = stableAttemptKey(first, '{"a":2}', () => "key-2");
    assert.equal(edited.key, "key-2");
  });
});
