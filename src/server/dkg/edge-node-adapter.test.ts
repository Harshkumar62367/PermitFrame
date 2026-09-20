import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCliTable } from "./edge-node-adapter";

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
