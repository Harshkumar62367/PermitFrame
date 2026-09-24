import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { EdgeNodeAdapter, isDkgUnavailable, parseCliTable, redactSecrets } from "./edge-node-adapter";
import type { CliTransport } from "./transports";

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
    // Synthetic fixtures only - never real key material.
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
    assert.equal(redactSecrets("Edge Node running - 6 peer(s)"), "Edge Node running - 6 peer(s)");
  });
});

describe("isDkgUnavailable", () => {
  it("recognizes transport and network failures", () => {
    assert.ok(isDkgUnavailable("dkg CLI failed (status ): Command failed: ssh -i key"));
    assert.ok(isDkgUnavailable("Edge Node unreachable - check the target"));
    assert.ok(isDkgUnavailable("fetch failed"));
    assert.ok(isDkgUnavailable("connect ECONNREFUSED 127.0.0.1:9200"));
  });

  it("rejects caller bugs and validation errors", () => {
    assert.ok(!isDkgUnavailable("idempotencyKey must be 1-128 chars"));
    assert.ok(!isDkgUnavailable("Campaign not found"));
    assert.ok(!isDkgUnavailable(""));
  });
});

const savedCg = process.env.DKG_CONTEXT_GRAPH_ID;

describe("listPassports source-media binding", () => {
  before(() => {
    // Skip context-graph resolution: the canned id is used verbatim.
    process.env.DKG_CONTEXT_GRAPH_ID = "test-graph";
  });

  after(() => {
    if (savedCg === undefined) delete process.env.DKG_CONTEXT_GRAPH_ID;
    else process.env.DKG_CONTEXT_GRAPH_ID = savedCg;
  });

  it("aggregates multiple pf:sourceMedia rows into distinct media ids", async () => {
    const queries: string[][] = [];
    const transport: CliTransport = {
      run: async (args: string[]) => {
        queries.push(args);
        const header = [
          "passport",
          "creatorId",
          "creatorName",
          "platform",
          "country",
          "transformation",
          "status",
          "validFrom",
          "validUntil",
          "attestedAt",
          "declaration",
          "sourceMedia"
        ].join("   ");
        const row = (transformation: string, media: string) =>
          [
            "urn:permitframe:passport:pp1",
            "c1",
            "Creator",
            "instagram",
            "GR",
            transformation,
            "active",
            "2026-01-01",
            "2027-01-01",
            "2026-01-01",
            "ok",
            media
          ].join("   ");
        return [
          header,
          "─".repeat(header.length),
          row("edit", "urn:permitframe:media:m1"),
          row("animate", "urn:permitframe:media:m2"),
          "2 row(s)"
        ].join("\n");
      }
    };
    const passports = await new EdgeNodeAdapter(transport).listPassports("c1");
    assert.equal(passports.length, 1);
    assert.deepEqual(passports[0].sourceMediaIds, ["m1", "m2"]);
    assert.deepEqual(passports[0].allowedTransformations, ["edit", "animate"]);
  });
});
