import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDkgUnavailable, parseCliTable, redactSecrets } from "./edge-node-adapter";

describe("parseCliTable", () => {
  it("parses data rows and drops the trailing count summary", () => {
    const out = [
      "s                           verdict",
      "──────────────────────────  ───────",
      "urn:permitframe:acceptance  allow",
      "",
      "1 row(s)"
    ].join("\n");
    assert.deepEqual(parseCliTable(out), [{ s: "urn:permitframe:acceptance", verdict: "allow" }]);
  });

  it("returns empty when there is no table", () => {
    assert.deepEqual(parseCliTable("Nothing published yet"), []);
  });
});

describe("redactSecrets", () => {
  it("strips private keys, RPC keys, and bearer tokens", () => {
    // Synthetic fixtures only — never real key material.
    const fakeKey = `0x${"ab".repeat(32)}`;
    const unsanitized = `key ${fakeKey} rpc https://x/v2/alch_SYNTHETIC-TEST-KEY-0000 auth Bearer abc.def-ghi sk-AbC1234567890`;
    const clean = redactSecrets(unsanitized);
    assert.ok(!clean.includes(fakeKey));
    assert.ok(!clean.includes("alch_SYNTHETIC"));
    assert.ok(!clean.includes("Bearer abc"));
    assert.ok(!clean.includes("sk-AbC1234567890"));
    assert.ok(clean.includes("[redacted]"));
  });

  it("leaves ordinary text untouched", () => {
    assert.equal(redactSecrets("Edge Node running — 6 peer(s)"), "Edge Node running — 6 peer(s)");
  });
});

describe("isDkgUnavailable", () => {
  it("recognizes transport and network failures", () => {
    assert.ok(isDkgUnavailable("dkg CLI failed (status ): Command failed: ssh -i key"));
    assert.ok(isDkgUnavailable("Edge Node unreachable — check the target"));
    assert.ok(isDkgUnavailable("fetch failed"));
    assert.ok(isDkgUnavailable("connect ECONNREFUSED 127.0.0.1:9200"));
  });

  it("rejects caller bugs and validation errors", () => {
    assert.ok(!isDkgUnavailable("idempotencyKey must be 1–128 chars"));
    assert.ok(!isDkgUnavailable("Campaign not found"));
    assert.ok(!isDkgUnavailable(""));
  });
});
