import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { KaRecord } from "./dkg/adapter";
import { emptyDb } from "./store";
import {
  anchorReceipts,
  LEDGER_UNCONFIRMED,
  type ReceiptAnchorFn
} from "./receipt-publication";
import { buildPublicSnapshot, newVerificationRef } from "./verification-snapshot";
import {
  classifyReceiptForAnchor,
  type Campaign,
  type Database,
  type DerivativeReceipt
} from "./types";

/**
 * Proof-ledger anchoring tests. The DKG call is always an injected stub -
 * zero provider traffic, zero ledger traffic, zero network. The memory
 * store round-trips through JSON so every read is a fresh load, exactly
 * like a page refresh hitting the database.
 */

function receipt(over: Partial<DerivativeReceipt> = {}): DerivativeReceipt {
  return {
    id: "rc_test",
    campaignId: "cmp_test",
    jobId: "job_test",
    label: "Test output",
    mediaType: "image",
    format: "1:1",
    outputUrl: "https://cdn.example/out.png",
    capability: "flux-dev",
    promptHash: "ph_test",
    claimsUsed: [],
    generatedAt: new Date().toISOString(),
    visibility: "public",
    storageStatus: "stored",
    derivedFrom: { sourceMediaId: "m1", passportId: "p1", productFactsId: "f1" },
    ...over
  } as DerivativeReceipt;
}

function campaignWith(receipts: DerivativeReceipt[]): Campaign {
  return {
    id: "cmp_test",
    title: "Test campaign",
    brand: "brand",
    productName: "product",
    request: {
      platform: "instagram",
      country: "US",
      requestedClaims: [],
      transformation: "image",
      creativeBrief: "A sufficiently long creative brief for the publish probe."
    },
    status: "approved",
    jobs: [],
    receipts,
    creatorId: "creator_test",
    sourceMediaId: "media_test",
    passportId: "passport_test",
    productFactsId: "facts_test",
    comments: [],
    captions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function kaRecord(over: Partial<KaRecord> = {}): KaRecord {
  return {
    ual: "",
    explorerUrl: "",
    publicationStatus: "shared",
    name: "ka_test",
    content: {},
    publishedAt: new Date().toISOString(),
    mode: "edge-node",
    ...over
  };
}

function memoryDb(receipts: DerivativeReceipt[]): Database {
  const db = emptyDb();
  db.campaigns.push(campaignWith(receipts));
  return db;
}

/** Fresh-load memory deps: every read round-trips, like a page refresh. */
function memoryDeps(db: Database, anchor: ReceiptAnchorFn) {
  return {
    load: async (): Promise<Database> => JSON.parse(JSON.stringify(db)) as Database,
    save: async (mutator: (d: Database) => void): Promise<Database> => {
      const copy = JSON.parse(JSON.stringify(db)) as Database;
      mutator(copy);
      for (const key of Object.keys(copy) as (keyof Database)[]) {
        (db[key] as unknown) = copy[key];
      }
      return db;
    },
    anchor
  };
}

function readReceipt(db: Database, id: string): DerivativeReceipt {
  const found = db.campaigns.find((c) => c.id === "cmp_test")?.receipts.find((r) => r.id === id);
  assert.ok(found, `receipt ${id} must exist`);
  return found;
}

describe("anchorReceipts", () => {
  it("does not count Shared Working Memory evidence (empty UAL) as published", async () => {
    // The exact edge-mode publish() shape that caused the false "4 records
    // published" report: success envelope, no UAL.
    const db = memoryDb([receipt({ id: "rc_swm" })]);
    const calls: string[] = [];
    const { results } = await anchorReceipts({
      campaignId: "cmp_test",
      deps: memoryDeps(db, async (r) => {
        calls.push(r.id);
        return kaRecord({ ual: "", publicationStatus: "shared", explorerUrl: "" });
      })
    });
    assert.deepEqual(results, [
      { receiptId: "rc_swm", status: "failed", reason: LEDGER_UNCONFIRMED }
    ]);
    assert.deepEqual(calls, ["rc_swm"]);
    const stored = readReceipt(db, "rc_swm");
    assert.equal(stored.ual, undefined);
    assert.equal(stored.publicationStatus, "failed");
    assert.equal(stored.publicationError, LEDGER_UNCONFIRMED);
    // Empty UALs never count: no anchored result exists.
    assert.equal(results.filter((r) => r.status === "anchored").length, 0);
  });

  it("marks a genuinely finalized record anchored and clears it from pending", async () => {
    const db = memoryDb([receipt({ id: "rc_vm" })]);
    const { results } = await anchorReceipts({
      campaignId: "cmp_test",
      deps: memoryDeps(db, async () =>
        kaRecord({
          ual: "did:dkg:otp/0xabc/1",
          explorerUrl: "https://dkg.origintrail.io/explore?ual=did%3Adkg%3Aotp%2F0xabc%2F1",
          publicationStatus: "anchored",
          mode: "edge-node"
        })
      )
    });
    assert.equal(results[0].status, "anchored");
    assert.equal(results[0].ual, "did:dkg:otp/0xabc/1");
    const stored = readReceipt(db, "rc_vm");
    assert.equal(stored.ual, "did:dkg:otp/0xabc/1");
    assert.equal(stored.publicationStatus, "anchored");
    // Pending targeting uses the same classifier as the UI: anchored rows
    // are never actionable again.
    assert.equal(classifyReceiptForAnchor(stored), "already_anchored");
    const actionable = (db.campaigns[0].receipts as DerivativeReceipt[]).filter(
      (r) => classifyReceiptForAnchor(r) === "eligible"
    );
    assert.deepEqual(actionable, []);
  });

  it("never republishes an already-anchored record on a second attempt", async () => {
    const db = memoryDb([receipt({ id: "rc_done", ual: "did:dkg:otp/0xabc/1", publicationStatus: "anchored" })]);
    let calls = 0;
    const { results } = await anchorReceipts({
      campaignId: "cmp_test",
      deps: memoryDeps(db, async () => {
        calls += 1;
        return kaRecord({ ual: "did:dkg:otp/0xabc/2", publicationStatus: "anchored" });
      })
    });
    assert.deepEqual(results, [{ receiptId: "rc_done", status: "already_anchored" }]);
    assert.equal(calls, 0);
    assert.equal(readReceipt(db, "rc_done").ual, "did:dkg:otp/0xabc/1");
  });

  it("skips private records without ever calling the anchor fn", async () => {
    const db = memoryDb([
      receipt({ id: "rc_priv", visibility: "private" }),
      receipt({ id: "rc_pub" })
    ]);
    const calls: string[] = [];
    const { results } = await anchorReceipts({
      campaignId: "cmp_test",
      deps: memoryDeps(db, async (r) => {
        calls.push(r.id);
        return kaRecord({ ual: `did:dkg:otp/0xabc/${r.id}`, publicationStatus: "anchored" });
      })
    });
    assert.deepEqual(results, [
      { receiptId: "rc_priv", status: "skipped_private" },
      {
        receiptId: "rc_pub",
        status: "anchored",
        ual: "did:dkg:otp/0xabc/rc_pub",
        explorerUrl: ""
      }
    ]);
    assert.deepEqual(calls, ["rc_pub"]);
    assert.equal(readReceipt(db, "rc_priv").publicationStatus, undefined);
  });

  it("lets one failed record fail without blocking the others", async () => {
    const db = memoryDb([receipt({ id: "rc_bad" }), receipt({ id: "rc_good" })]);
    const { results } = await anchorReceipts({
      campaignId: "cmp_test",
      deps: memoryDeps(db, async (r) => {
        if (r.id === "rc_bad") throw new Error("dkg CLI failed (publisher publish-async): boom");
        return kaRecord({ ual: "did:dkg:otp/0xabc/9", publicationStatus: "anchored" });
      })
    });
    assert.equal(results[0].status, "failed");
    assert.ok(results[0].reason && results[0].reason.length > 0 && results[0].reason.length <= 200);
    assert.ok(!results[0].reason.includes("boom") || results[0].reason.length <= 200);
    assert.equal(results[1].status, "anchored");
    assert.equal(readReceipt(db, "rc_bad").publicationStatus, "failed");
    assert.equal(readReceipt(db, "rc_good").publicationStatus, "anchored");
  });

  it("treats local-evidence answers as honest failure, never as anchored", async () => {
    const db = memoryDb([receipt({ id: "rc_local" })]);
    const { results } = await anchorReceipts({
      campaignId: "cmp_test",
      deps: memoryDeps(db, async () =>
        kaRecord({ ual: "did:dkg:local/permitframe-receipt-rc_local", publicationStatus: "local", mode: "local-evidence" })
      )
    });
    assert.equal(results[0].status, "failed");
    assert.match(results[0].reason ?? "", /Local evidence mode/);
    const stored = readReceipt(db, "rc_local");
    assert.equal(stored.ual, undefined);
    assert.equal(stored.publicationStatus, "failed");
  });

  it("persists the in-flight publishing claim so a refresh sees it, then finalizes", async () => {
    const db = memoryDb([receipt({ id: "rc_slow" })]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = anchorReceipts({
      campaignId: "cmp_test",
      deps: memoryDeps(db, async () => {
        await gate;
        return kaRecord({ ual: "did:dkg:otp/0xabc/7", publicationStatus: "anchored" });
      })
    });
    // Let the route mark publishing before the anchor resolves.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const midFlight = readReceipt(db, "rc_slow");
    assert.equal(midFlight.publicationStatus, "publishing");
    assert.ok(midFlight.publicationUpdatedAt);
    assert.equal(classifyReceiptForAnchor(midFlight), "publishing");
    release();
    const { results } = await run;
    assert.equal(results[0].status, "anchored");
    assert.equal(readReceipt(db, "rc_slow").publicationStatus, "anchored");
  });

  it("retries orphaned publishing claims but skips fresh in-flight ones", async () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const db = memoryDb([
      receipt({ id: "rc_orphan", publicationStatus: "publishing", publicationUpdatedAt: old }),
      receipt({ id: "rc_live", publicationStatus: "publishing", publicationUpdatedAt: new Date().toISOString() })
    ]);
    const calls: string[] = [];
    const { results } = await anchorReceipts({
      campaignId: "cmp_test",
      deps: memoryDeps(db, async (r) => {
        calls.push(r.id);
        return kaRecord({ ual: `did:dkg:otp/0xabc/${r.id}`, publicationStatus: "anchored" });
      })
    });
    assert.deepEqual(results.map((r) => r.status), ["anchored", "publishing"]);
    assert.deepEqual(calls, ["rc_orphan"]);
  });

  it("limits explicit receipt batches to the requested ids", async () => {
    const db = memoryDb([receipt({ id: "rc_a" }), receipt({ id: "rc_b" })]);
    const calls: string[] = [];
    const { results } = await anchorReceipts({
      campaignId: "cmp_test",
      receiptIds: ["rc_b"],
      deps: memoryDeps(db, async (r) => {
        calls.push(r.id);
        return kaRecord({ ual: "did:dkg:otp/0xabc/3", publicationStatus: "anchored" });
      })
    });
    assert.deepEqual(results.map((r) => r.receiptId), ["rc_b"]);
    assert.deepEqual(calls, ["rc_b"]);
    assert.equal(readReceipt(db, "rc_a").publicationStatus, undefined);
  });
});

describe("verification independence", () => {
  it("builds the vrf snapshot from UAL-less receipts - anchoring is not a gate", () => {
    const db = memoryDb([
      receipt({ id: "rc_plain" }),
      receipt({ id: "rc_failed", publicationStatus: "failed", publicationError: "nope" })
    ]);
    const campaign = db.campaigns[0] as Campaign;
    const snapshot = buildPublicSnapshot({
      ref: newVerificationRef(),
      campaign,
      passport: null,
      facts: null
    });
    assert.ok(snapshot.ref.startsWith("vrf_"));
    assert.deepEqual(
      snapshot.outputs.map((o) => o.id).sort(),
      ["rc_failed", "rc_plain"]
    );
    // No campaign anchor either: still a valid snapshot with null proof links.
    assert.equal(snapshot.ual, null);
    assert.equal(snapshot.explorerUrl, null);
  });
});
