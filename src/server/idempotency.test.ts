import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  completeIdempotencySlot,
  failIdempotencySlot,
  fingerprintCreationIntent,
  IdempotencyMismatchError,
  readIdempotencySlot,
  reserveIdempotencySlot,
  withIdempotencyLock,
  type CreationIntent
} from "./idempotency";
import type { Database } from "./types";

function blankDb(): Database {
  return {
    creators: [],
    passports: [],
    sourceMedia: [],
    productFacts: [],
    campaigns: [],
    consentInvites: [],
    events: [],
    idempotencyKeys: {},
    deletedCampaigns: []
  };
}

const INTENT: CreationIntent = {
  title: "Instagram campaign — GR",
  brand: "Maya",
  productName: "TerraRunner",
  creatorId: "crt_1",
  sourceMediaId: "med_1",
  passportId: "pp_1",
  productFactsId: "pf_1",
  platform: "instagram",
  country: "GR",
  requestedClaims: ["made with recycled materials"],
  transformation: "image",
  creativeBrief: "Golden-hour rooftop shot of the TerraRunner."
};

describe("fingerprintCreationIntent", () => {
  it("is stable for identical intent and normalizes case/whitespace/order", () => {
    const a = fingerprintCreationIntent(INTENT);
    const b = fingerprintCreationIntent({
      ...INTENT,
      country: "gr",
      platform: "Instagram",
      requestedClaims: ["  Made With Recycled Materials "],
      creativeBrief: "  Golden-hour rooftop shot of the TerraRunner. "
    });
    assert.equal(a, b);
  });

  it("differs when the rights-relevant payload differs", () => {
    const base = fingerprintCreationIntent(INTENT);
    assert.notEqual(base, fingerprintCreationIntent({ ...INTENT, country: "DE" }));
    assert.notEqual(base, fingerprintCreationIntent({ ...INTENT, requestedClaims: ["zero gravity"] }));
    assert.notEqual(base, fingerprintCreationIntent({ ...INTENT, transformation: "video" }));
  });
});

describe("idempotency slots", () => {
  it("same key twice replays the original campaign id without a second row", () => {
    const db = blankDb();
    const fp = fingerprintCreationIntent(INTENT);
    // First submission: reserve, "create" (push one campaign), complete.
    assert.equal(reserveIdempotencySlot(db, "key-1", fp, "2026-01-01T00:00:00.000Z").outcome, "reserved");
    db.campaigns.push({ id: "cmp_original" } as Database["campaigns"][number]);
    completeIdempotencySlot(db, "key-1", "cmp_original", "2026-01-01T00:00:01.000Z");
    // Retry of the same submission: replay, no new campaign pushed.
    const replay = reserveIdempotencySlot(db, "key-1", fp, "2026-01-01T00:00:02.000Z");
    assert.equal(replay.outcome, "replay");
    assert.equal((replay as { campaignId: string }).campaignId, "cmp_original");
    assert.equal(db.campaigns.length, 1);
  });

  it("two unique keys create independently", () => {
    const db = blankDb();
    const fp = fingerprintCreationIntent(INTENT);
    assert.equal(reserveIdempotencySlot(db, "key-a", fp, "t").outcome, "reserved");
    assert.equal(reserveIdempotencySlot(db, "key-b", fp, "t").outcome, "reserved");
    completeIdempotencySlot(db, "key-a", "cmp_a", "t");
    completeIdempotencySlot(db, "key-b", "cmp_b", "t");
    assert.equal(readIdempotencySlot(db, "key-a")?.campaignId, "cmp_a");
    assert.equal(readIdempotencySlot(db, "key-b")?.campaignId, "cmp_b");
  });

  it("same key with a different payload is a mismatch, never a second campaign", () => {
    const db = blankDb();
    const fpA = fingerprintCreationIntent(INTENT);
    const fpB = fingerprintCreationIntent({ ...INTENT, country: "DE" });
    reserveIdempotencySlot(db, "key-1", fpA, "t");
    completeIdempotencySlot(db, "key-1", "cmp_original", "t");
    const outcome = reserveIdempotencySlot(db, "key-1", fpB, "t");
    assert.equal(outcome.outcome, "mismatch");
    assert.equal(db.campaigns.length, 0);
    assert.ok(new IdempotencyMismatchError() instanceof Error);
  });

  it("failed and orphaned-processing rows are taken over, never replayed", () => {
    const db = blankDb();
    const fp = fingerprintCreationIntent(INTENT);
    reserveIdempotencySlot(db, "key-1", fp, "t");
    failIdempotencySlot(db, "key-1", "t");
    assert.equal(reserveIdempotencySlot(db, "key-1", fp, "t").outcome, "takeover");
    // Orphaned processing (crashed attempt, no live holder): also take over.
    const db2 = blankDb();
    reserveIdempotencySlot(db2, "key-2", fp, "t");
    assert.equal(reserveIdempotencySlot(db2, "key-2", fp, "t").outcome, "takeover");
  });

  it("legacy workspace rows without the map do not crash", () => {
    const db = blankDb() as Database;
    delete (db as Partial<Database>).idempotencyKeys;
    assert.equal(reserveIdempotencySlot(db, "key-1", "fp", "t").outcome, "reserved");
    assert.ok(readIdempotencySlot(db, "key-1"));
  });
});

describe("withIdempotencyLock", () => {
  it("concurrent duplicates share one execution and one result (double-click/retry race)", async () => {
    let runs = 0;
    const work = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 50));
      return "cmp_shared";
    };
    const [a, b, c] = await Promise.all([
      withIdempotencyLock("ws:key", work),
      withIdempotencyLock("ws:key", work),
      withIdempotencyLock("ws:key", work)
    ]);
    assert.equal(runs, 1);
    assert.deepEqual([a, b, c], ["cmp_shared", "cmp_shared", "cmp_shared"]);
  });

  it("sequential submissions run independently and the lock never sticks after failure", async () => {
    let runs = 0;
    await assert.rejects(() =>
      withIdempotencyLock("ws:fail", async () => {
        runs += 1;
        throw new Error("boom");
      })
    );
    const result = await withIdempotencyLock("ws:fail", async () => {
      runs += 1;
      return "recovered";
    });
    assert.equal(runs, 2);
    assert.equal(result, "recovered");
  });
});
