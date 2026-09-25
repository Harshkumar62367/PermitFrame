import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Campaign, ProductFacts } from "./types";
import { emptyDb } from "./store";
import { shouldMirrorFactsWrite } from "./platform";

/**
 * Normalized-mirror decision for brand-rule writes. Only a brand-new record
 * may skip the full mirror; every existing record mirrors immediately so a
 * concurrent campaign reference cannot leave normalized detail stale. Pure
 * and unit-tested; the DB-backed mirror path itself is unchanged.
 */
function facts(id: string): ProductFacts {
  return { id } as ProductFacts;
}

describe("shouldMirrorFactsWrite", () => {
  it("skips the mirror for brand-new records", () => {
    assert.equal(shouldMirrorFactsWrite(emptyDb(), "facts_new"), false);
  });

  it("mirrors every existing record, even before a campaign references it", () => {
    const db = emptyDb();
    db.productFacts = [facts("facts_mine")];
    assert.equal(shouldMirrorFactsWrite(db, "facts_mine"), true);
  });

  it("also mirrors an existing record already used by a campaign", () => {
    const db = emptyDb();
    db.productFacts = [facts("facts_mine")];
    db.campaigns = [{ id: "cmp_1", productFactsId: "facts_mine" } as Campaign];
    assert.equal(shouldMirrorFactsWrite(db, "facts_mine"), true);
  });
});
