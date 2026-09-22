import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COUNTRIES, countryName } from "./countries";

describe("countries", () => {
  it("covers the ISO alpha-2 set with unique codes", () => {
    assert.ok(COUNTRIES.length >= 240, `expected full coverage, got ${COUNTRIES.length}`);
    const codes = COUNTRIES.map((c) => c.code);
    assert.equal(new Set(codes).size, codes.length);
    assert.ok(codes.every((c) => /^[A-Z]{2}$/.test(c)));
  });

  it("resolves display names and falls back to the code", () => {
    assert.equal(countryName("GR"), "Greece");
    assert.equal(countryName("gr"), "Greece");
    assert.equal(countryName("DE"), "Germany");
    assert.equal(countryName("XX"), "XX");
  });
});
