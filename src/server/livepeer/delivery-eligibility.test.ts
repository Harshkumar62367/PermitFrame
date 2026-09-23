import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Campaign, Database, DerivativeReceipt, ProductionJob, ProductionStagePlan } from "../types";
import {
  deliveryBlockedJobIds,
  deliveryBlockReason,
  isDeliverableReceipt
} from "../types";
import { emptyDb } from "../store";
import { isCloudinaryConfigured } from "../cloudinary";
import { memoryStore, setRunStore } from "./run-store";
import { finalizeStoredDelivery, persistLocalDelivery, persistPreviewInBackground, publishReceipt } from "./pipeline";
import { publicOutputsForShare } from "../public-share";
import { isDispatchableJob } from "./run-dispatch";
import {
  canCreateVariations,
  deliverableState,
  queueStatusForJob
} from "@/components/studio/studio-model";

/**
 * Hard aspect-ratio delivery guard: a ratio-mismatched output stays stored
 * and reviewable but is never delivery-ready and never reaches client
 * share. Pure unit tests (no DB, no provider, no dispatch) plus
 * workspace-seam atomicity tests below (in-memory store, mocked ledger).
 */

function receipt(over: Partial<DerivativeReceipt> = {}): DerivativeReceipt {
  return {
    id: "rcpt_1",
    campaignId: "cmp_1",
    jobId: "job_1",
    label: "Feed creative (1:1)",
    mediaType: "image",
    format: "1:1",
    outputUrl: "https://cdn.example/kept.png",
    capability: "flux-dev",
    promptHash: "ph",
    claimsUsed: [],
    derivedFrom: { sourceMediaId: "m1", passportId: "p1", productFactsId: "f1" },
    generatedAt: "2026-01-01T00:00:00.000Z",
    storageStatus: "stored",
    visibility: "shared",
    ...over
  };
}

function job(over: Partial<ProductionJob> = {}): ProductionJob {
  return {
    id: "job_1",
    campaignId: "cmp_1",
    stageId: "feed",
    kind: "text-to-image",
    capability: "flux-dev",
    prompt: "a product still",
    status: "ready_to_share",
    outputUrl: "https://cdn.example/kept.png",
    startedAt: "2026-01-01T00:00:00.000Z",
    ...over
  };
}

function campaign(receipts: DerivativeReceipt[], jobs: ProductionJob[], status: Campaign["status"] = "review"): Campaign {
  return {
    id: "cmp_1",
    title: "Delivery probe",
    brand: "brand",
    productName: "product",
    request: {
      platform: "instagram",
      country: "US",
      requestedClaims: [],
      transformation: "video",
      creativeBrief: "A sufficiently long creative brief for the delivery probe."
    },
    status,
    jobs,
    receipts,
    creatorId: "c1",
    sourceMediaId: "m1",
    passportId: "p1",
    productFactsId: "f1",
    comments: [],
    captions: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("delivery block reason", () => {
  it("matching ratio remains deliverable with no structured reason", () => {
    const r = receipt({ aspectVerdict: "match", actualWidth: 1024, actualHeight: 1024 });
    assert.equal(deliveryBlockReason(r), null);
    assert.equal(isDeliverableReceipt(r), true);
  });

  it("persists a structured non-deliverable reason for mismatches", () => {
    // Stored reason (written atomically by publishReceipt) wins verbatim.
    const stored = receipt({ aspectVerdict: "mismatch", deliveryBlocked: "aspect_ratio_mismatch" });
    assert.equal(deliveryBlockReason(stored), "aspect_ratio_mismatch");
    assert.equal(isDeliverableReceipt(stored), false);
    // Legacy rows carrying only the verdict derive the same reason on read.
    const legacy = receipt({ aspectVerdict: "mismatch", actualWidth: 1024, actualHeight: 768 });
    assert.equal(deliveryBlockReason(legacy), "aspect_ratio_mismatch");
    assert.equal(isDeliverableReceipt(legacy), false);
  });

  it("missing dimensions or verdict preserves legacy behavior (no invented mismatch)", () => {
    assert.equal(deliveryBlockReason(receipt({})), null);
    assert.equal(deliveryBlockReason(receipt({ aspectVerdict: "unknown" })), null);
    assert.equal(isDeliverableReceipt(receipt({})), true);
    // Unstored outputs stay non-sharable for the pre-existing storage reason.
    assert.equal(isDeliverableReceipt(receipt({ storageStatus: undefined })), false);
  });

  it("derives blocked job ids for queue/plan display", () => {
    const ids = deliveryBlockedJobIds([
      receipt({ jobId: "job_1", aspectVerdict: "mismatch" }),
      receipt({ jobId: "job_2", aspectVerdict: "match" })
    ]);
    assert.deepEqual([...ids], ["job_1"]);
  });
});

describe("public share delivery filter", () => {
  it("keeps matching outputs shareable", () => {
    const outputs = publicOutputsForShare(
      campaign([receipt({ id: "rcpt_ok", aspectVerdict: "match" })], [job()]),
      null
    );
    assert.deepEqual(outputs.map((o) => o.id), ["rcpt_ok"]);
  });

  it("never exposes mismatches, including already-approved legacy campaigns", () => {
    const legacyMismatch = receipt({
      id: "rcpt_legacy",
      aspectVerdict: "mismatch",
      actualWidth: 1024,
      actualHeight: 768,
      outputUrl: "https://cdn.example/mismatched-internal.png"
    });
    const outputs = publicOutputsForShare(
      campaign([legacyMismatch, receipt({ id: "rcpt_ok", aspectVerdict: "match" })], [job()], "approved"),
      null
    );
    assert.deepEqual(outputs.map((o) => o.id), ["rcpt_ok"]);
    const leaked = JSON.stringify(outputs);
    assert.ok(!leaked.includes("mismatched-internal.png"), "excluded asset URL must not leak");
  });

  it("private exclusion still works, including private mismatches", () => {
    const outputs = publicOutputsForShare(
      campaign(
        [
          receipt({ id: "rcpt_ok", aspectVerdict: "match" }),
          receipt({ id: "rcpt_priv", visibility: "private" }),
          receipt({ id: "rcpt_priv_bad", visibility: "private", aspectVerdict: "mismatch" })
        ],
        [job()]
      ),
      null
    );
    assert.deepEqual(outputs.map((o) => o.id), ["rcpt_ok"]);
  });

  it("an all-blocked pack shares zero outputs without leaking internals", () => {
    const outputs = publicOutputsForShare(
      campaign([receipt({ id: "rcpt_bad", aspectVerdict: "mismatch", outputUrl: "https://cdn.example/blocked.png" })], [job()]),
      "ver_1"
    );
    assert.deepEqual(outputs, []);
    assert.ok(!JSON.stringify(outputs).includes("blocked.png"));
  });

  it("exposes no raw provider or internal details on public outputs", () => {
    const outputs = publicOutputsForShare(
      campaign(
        [
          receipt({
            id: "rcpt_ok",
            aspectVerdict: "match",
            providerUrlFingerprint: "fp-secret",
            costUsd: 0.42
          })
        ],
        [job()]
      ),
      null
    );
    const keys = Object.keys(outputs[0] ?? {}).sort();
    assert.deepEqual(keys, ["aspectVerdict", "claimsUsed", "format", "id", "label", "mediaType", "outputUrl", "verifyUrl"]);
    const leaked = JSON.stringify(outputs);
    assert.ok(!leaked.includes("fp-secret"), "provider fingerprint must not leak");
  });
});

describe("studio delivery derivation", () => {
  it("queue derives needs-review, never Ready, for blocked outputs", () => {
    assert.equal(queueStatusForJob("ready_to_share", true), "needs_review");
    assert.equal(queueStatusForJob("ready_to_share", false), "ready_to_share");
    for (const s of ["queued", "generating", "preview_ready", "failed"] as const) {
      assert.equal(queueStatusForJob(s, true), s);
    }
  });

  it("creative plan derives review, never Complete, for blocked stages", () => {
    const jobs = [job({ id: "job_1", stageId: "feed" })];
    assert.equal(deliverableState(jobs, ["feed"], new Set(["feed"])), "review");
    assert.equal(deliverableState(jobs, ["feed"], new Set()), "done");
    assert.equal(deliverableState(jobs, ["feed"]), "done");
  });

  it("mismatch retains review, refine, and variation eligibility", () => {
    // Variations: completed stored image - delivery blocking is not an input.
    assert.equal(canCreateVariations({ mediaType: "image" }, "ready_to_share"), true);
    assert.equal(canCreateVariations({ mediaType: "video" }, "ready_to_share"), false);
    assert.equal(canCreateVariations({ mediaType: "image" }, "failed"), false);
    // Refine/queue actions key off the untouched ready_to_share status.
    assert.equal(job({ status: "ready_to_share" }).status, "ready_to_share");
  });
});

describe("production dispatch safety", () => {
  it("no provider dispatch occurs merely because delivery is blocked", () => {
    // A completed-but-non-deliverable asset is settled work, never queued.
    assert.equal(isDispatchableJob(job({ status: "ready_to_share" })), false);
    assert.equal(
      isDispatchableJob(job({ status: "ready_to_share", outputUrl: "https://cdn.example/blocked.png" })),
      false
    );
    assert.equal(isDispatchableJob(job({ status: "queued", outputUrl: undefined, livepeerJobId: undefined })), true);
    assert.equal(isDispatchableJob(job({ status: "failed" })), false);
    assert.equal(isDispatchableJob(job({ status: "cancelled" })), false);
  });
});

describe("finalization atomicity (workspace seam)", () => {
  const WS = "ws_atomic";

  afterEach(() => {
    setRunStore(null);
  });

  function stage(): ProductionStagePlan {
    return {
      id: "feed",
      kind: "text-to-image",
      capability: "flux-dev",
      label: "Feed creative",
      format: "1:1",
      dependsOnStageIds: [],
      inputSource: "approved-source",
      qualityProfile: "balanced",
      role: "conceptImage"
    };
  }

  function seed(status: ProductionJob["status"]): Database {
    const db = emptyDb();
    db.campaigns.push({
      ...campaign([], [job({ status, outputUrl: undefined })]),
      preflight: {
        decision: "allow",
        checkedAt: "2026-01-01T00:00:00.000Z",
        blockers: [],
        allowedClaims: [],
        promptConstraints: [],
        plan: [stage()],
        queriedRights: [],
        queriedFacts: [],
        sparqlPreview: ""
      }
    });
    return db;
  }

  function deferredLedger() {
    type LedgerRecord = { ual: string; publicationStatus: "shared" };
    let release!: (value: LedgerRecord) => void;
    let reject!: (reason: Error) => void;
    const gate = new Promise<LedgerRecord>((resolve, rej) => {
      release = resolve;
      reject = rej;
    });
    let calls = 0;
    return {
      calls: () => calls,
      resolve: (ual = "did:dkg:test/0xabc/1") => release({ ual, publicationStatus: "shared" }),
      fail: () => reject(new Error("DKG node unreachable")),
      publish: async () => {
        calls += 1;
        return gate;
      }
    };
  }

  it("mismatch lands job-ready and receipt-blocked in one observable state", async () => {
    const { store, read } = memoryStore(seed("storage_pending"));
    setRunStore(store);
    const { receiptId, created } = await persistLocalDelivery({
      campaignId: "cmp_1",
      jobId: "job_1",
      canonicalUrl: "https://cdn.example/wide.png",
      capability: "flux-dev",
      storage: { publicId: "a1", url: "https://cdn.example/wide.png", width: 1024, height: 768 },
      scope: WS
    });
    assert.equal(created, true);
    const c = read().campaigns[0];
    const j = c.jobs[0];
    const r = c.receipts.find((x) => x.id === receiptId);
    // First observable state: ready job AND blocked receipt together.
    assert.equal(j.status, "ready_to_share");
    assert.equal(j.outputUrl, "https://cdn.example/wide.png");
    assert.ok(r, "receipt persisted in the same write");
    assert.equal(r?.aspectVerdict, "mismatch");
    assert.equal(deliveryBlockReason(r!), "aspect_ratio_mismatch");
    // Queue/plan/share derive non-deliverable immediately.
    assert.equal(queueStatusForJob(j.status, deliveryBlockedJobIds(c.receipts).has(j.id)), "needs_review");
    assert.equal(deliverableState(c.jobs, ["feed"], new Set(["feed"])), "review");
    assert.deepEqual(publicOutputsForShare(c, null).map((o) => o.id), []);
  });

  it("delayed or failed ledger publication never opens a Ready-without-receipt window", async () => {
    const { store, read } = memoryStore(seed("storage_pending"));
    setRunStore(store);
    const ledger = deferredLedger();
    const pending = publishReceipt(
      "cmp_1",
      "job_1",
      "https://cdn.example/wide.png",
      "flux-dev",
      { publicId: "a1", url: "https://cdn.example/wide.png", width: 1024, height: 768 },
      WS,
      { publish: ledger.publish }
    );
    // Yield to let the local write land while the ledger call is still gated.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const mid = read().campaigns[0];
    assert.equal(mid.jobs[0].status, "ready_to_share");
    assert.equal(mid.receipts.length, 1);
    assert.equal(deliveryBlockReason(mid.receipts[0]), "aspect_ratio_mismatch");
    assert.deepEqual(publicOutputsForShare(mid, null).map((o) => o.id), []);
    assert.equal(ledger.calls(), 1);
    // Fail the ledger: local delivery, block, and share filter are unaffected.
    ledger.fail();
    assert.equal(await pending, mid.receipts[0].id);
    const after = read().campaigns[0];
    assert.equal(after.receipts.length, 1);
    assert.equal(deliveryBlockReason(after.receipts[0]), "aspect_ratio_mismatch");
    assert.equal(after.receipts[0].publicationStatus, "failed");
    assert.equal(after.receipts[0].ual, undefined);
    assert.deepEqual(publicOutputsForShare(after, null).map((o) => o.id), []);
  });

  it("matching output remains deliverable through the same atomic path", async () => {
    const { store, read } = memoryStore(seed("storage_pending"));
    setRunStore(store);
    const { receiptId } = await persistLocalDelivery({
      campaignId: "cmp_1",
      jobId: "job_1",
      canonicalUrl: "https://cdn.example/square.png",
      capability: "flux-dev",
      storage: { publicId: "a1", url: "https://cdn.example/square.png", width: 1024, height: 1024 },
      scope: WS
    });
    const c = read().campaigns[0];
    const r = c.receipts.find((x) => x.id === receiptId)!;
    assert.equal(r.aspectVerdict, "match");
    assert.equal(isDeliverableReceipt(r), true);
    assert.deepEqual(publicOutputsForShare(c, null).map((o) => o.id), [receiptId]);
    assert.equal(deliverableState(c.jobs, ["feed"], new Set()), "done");
  });

  it("retry-storage path carries the same atomic guarantee", async () => {
    const { store, read } = memoryStore(seed("storage_retry_needed"));
    setRunStore(store);
    const ledger = deferredLedger();
    const pending = finalizeStoredDelivery({
      workspaceId: WS,
      campaignId: "cmp_1",
      jobId: "job_1",
      asset: { storageStatus: "stored", storageUrl: "https://cdn.example/wide.png", storagePublicId: "a1", storageWidth: 1024, storageHeight: 768 },
      publish: ledger.publish
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const mid = read().campaigns[0];
    assert.equal(mid.jobs[0].status, "ready_to_share");
    assert.equal(mid.receipts.length, 1);
    assert.equal(deliveryBlockReason(mid.receipts[0]), "aspect_ratio_mismatch");
    ledger.resolve();
    assert.deepEqual(await pending, { finalized: true });
    const after = read().campaigns[0];
    assert.equal(after.receipts[0].ual, "did:dkg:test/0xabc/1");
    assert.deepEqual(publicOutputsForShare(after, null).map((o) => o.id), []);
  });

  it("repeated finalization never duplicates receipts or clobbers state", async () => {
    const { store, read } = memoryStore(seed("storage_pending"));
    setRunStore(store);
    const first = await persistLocalDelivery({
      campaignId: "cmp_1",
      jobId: "job_1",
      canonicalUrl: "https://cdn.example/wide.png",
      capability: "flux-dev",
      storage: { publicId: "a1", url: "https://cdn.example/wide.png", width: 1024, height: 768 },
      scope: WS
    });
    const second = await persistLocalDelivery({
      campaignId: "cmp_1",
      jobId: "job_1",
      canonicalUrl: "https://cdn.example/wide.png",
      capability: "flux-dev",
      storage: { publicId: "a1", url: "https://cdn.example/wide.png", width: 1024, height: 768 },
      scope: WS
    });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.receiptId, first.receiptId);
    const c = read().campaigns[0];
    assert.equal(c.receipts.length, 1);
    assert.equal(deliveryBlockReason(c.receipts[0]), "aspect_ratio_mismatch");
    // Already-delivered retry is a no-op (inject ledger so no real DKG runs).
    assert.deepEqual(
      await finalizeStoredDelivery({
        workspaceId: WS,
        campaignId: "cmp_1",
        jobId: "job_1",
        asset: { storageStatus: "stored", storageUrl: "https://cdn.example/wide.png", storagePublicId: "a1" },
        publish: async () => ({ ual: "did:dkg:test/noop/1", publicationStatus: "shared" as const })
      }),
      { finalized: false }
    );
    assert.equal(read().campaigns[0].receipts.length, 1);
  });

  it("provider-hosted path finalizes job and receipt in one write, once", async () => {
    // This test drives the no-Cloudinary branch of persistPreviewInBackground.
    if (isCloudinaryConfigured()) return;
    const { store, read } = memoryStore(seed("preview_ready"));
    setRunStore(store);
    const ledger = deferredLedger();
    const pending = persistPreviewInBackground({
      workspaceId: WS,
      campaignId: "cmp_1",
      jobId: "job_1",
      providerUrl: "https://provider.example/hosted.png",
      promptHash: "ph",
      providerModel: "flux-dev",
      kind: "text-to-image",
      publish: ledger.publish
    });
    // While the ledger call is still gated, the first observable state must
    // already pair Ready with its receipt - never Ready with zero receipts.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const mid = read().campaigns[0];
    assert.equal(mid.jobs[0].status, "ready_to_share");
    assert.equal(mid.jobs[0].outputUrl, "https://provider.example/hosted.png");
    assert.equal(mid.receipts.length, 1);
    const receipt = mid.receipts[0];
    // Honest provider-hosted receipt: no storage fields, no invented
    // dimensions, unknown verdict, no delivery block.
    assert.equal(receipt.storageStatus, undefined);
    assert.equal(receipt.storageProvider, undefined);
    assert.equal(receipt.actualWidth, undefined);
    assert.equal(receipt.aspectVerdict, "unknown");
    assert.equal(deliveryBlockReason(receipt), null);
    assert.equal(ledger.calls(), 1);
    // A second worker finalizes nothing: no duplicate receipt, event, or
    // ledger attempt.
    const idleLedger = deferredLedger();
    await persistPreviewInBackground({
      workspaceId: WS,
      campaignId: "cmp_1",
      jobId: "job_1",
      providerUrl: "https://provider.example/hosted.png",
      promptHash: "ph",
      providerModel: "flux-dev",
      kind: "text-to-image",
      publish: idleLedger.publish
    });
    assert.equal(read().campaigns[0].receipts.length, 1);
    assert.equal(read().events.filter((e) => e.kind === "dkg.publish").length, 1);
    assert.equal(idleLedger.calls(), 0);
    // Ledger failure after local persistence leaves receipt and job intact.
    ledger.fail();
    await pending;
    const after = read().campaigns[0];
    assert.equal(after.jobs[0].status, "ready_to_share");
    assert.equal(after.receipts.length, 1);
    assert.equal(after.receipts[0].publicationStatus, "failed");
    assert.equal(after.receipts[0].ual, undefined);
  });
});
