import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Campaign, DerivativeReceipt } from "./types";
import { applyShareReviewDecision, publicOutputsForShare } from "./public-share";

/**
 * Client-delivery privacy: receipts marked private (captioned film
 * derivatives) never appear in the public share view, while public/shared
 * durable outputs keep their exact behavior. Pure unit tests over the
 * shared helper (no DB, no server).
 */

function receipt(over: Partial<DerivativeReceipt> = {}): DerivativeReceipt {
  return {
    id: "rcpt_base",
    campaignId: "cmp_share",
    jobId: "job_base",
    label: "Campaign keyframe (9:16)",
    mediaType: "image",
    format: "9:16",
    outputUrl: "https://cdn.example/kept.png",
    capability: "flux-dev",
    promptHash: "ph",
    claimsUsed: ["made with recycled materials"],
    derivedFrom: { sourceMediaId: "m1", passportId: "p1", productFactsId: "f1" },
    generatedAt: "2026-01-01T00:00:00.000Z",
    storageStatus: "stored",
    visibility: "shared",
    ...over
  };
}

function campaign(receipts: DerivativeReceipt[]): Campaign {
  return {
    id: "cmp_share",
    title: "Share probe",
    brand: "brand",
    productName: "product",
    request: {
      platform: "instagram",
      country: "US",
      requestedClaims: [],
      transformation: "video",
      creativeBrief: "A sufficiently long creative brief for the share probe."
    },
    status: "review",
    jobs: [],
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

describe("public share output privacy", () => {
  it("exposes shared outputs and hides a private caption derivative", () => {
    const outputs = publicOutputsForShare(
      campaign([
        receipt({ id: "rcpt_public" }),
        receipt({
          id: "rcpt_caption",
          label: "Campaign film reel · burned captions · 45s",
          mediaType: "video",
          outputUrl: "https://cdn.example/film-reel-captions.mp4",
          derivedFromFilmRunId: "filmrun_1",
          sourceReelUrl: "https://cdn.example/film-reel.mp4",
          captionLanguage: "en",
          visibility: "private"
        })
      ]),
      null
    );
    assert.deepEqual(outputs.map((o) => o.id), ["rcpt_public"]);
  });

  it("keeps public-visibility and legacy durable outputs listed unchanged", () => {
    const outputs = publicOutputsForShare(
      campaign([
        receipt({ id: "rcpt_pub", visibility: "public" }),
        receipt({ id: "rcpt_shared", visibility: "shared" })
      ]),
      "verifieref123"
    );
    assert.deepEqual(outputs.map((o) => o.id), ["rcpt_pub", "rcpt_shared"]);
    assert.ok(outputs.every((o) => o.verifyUrl === "/verify/verifieref123#output-" + o.id));
  });

  it("lists nothing when only private or no receipts exist", () => {
    assert.deepEqual(publicOutputsForShare(campaign([receipt({ id: "rcpt_priv", visibility: "private" })]), null), []);
    assert.deepEqual(publicOutputsForShare(campaign([]), null), []);
  });

  it("excludes not-yet-stored outputs even when shared and unblocked", () => {
    const outputs = publicOutputsForShare(
      campaign([
        receipt({ id: "rcpt_pending", storageStatus: "pending" }),
        receipt({ id: "rcpt_ok" })
      ]),
      null
    );
    assert.deepEqual(outputs.map((o) => o.id), ["rcpt_ok"]);
  });

  it("output entries carry no internal fields", () => {
    const outputs = publicOutputsForShare(campaign([receipt({ id: "rcpt_ok" })]), "ver_1");
    for (const o of outputs) {
      assert.deepEqual(
        Object.keys(o).sort(),
        ["claimsUsed", "format", "id", "label", "mediaType", "outputUrl", "verifyUrl"]
      );
    }
    const leaked = JSON.stringify(outputs);
    for (const banned of ["workspaceId", "passportId", "livepeerJobId", "session", "secret", "credential"]) {
      assert.ok(!leaked.includes(banned), `share output must not contain ${banned}`);
    }
  });
});

describe("share reviewer decisions", () => {
  it("an approved review records feedback but carries no status transition", () => {
    const r = applyShareReviewDecision(
      { id: "cmp_x", title: "X" },
      { decision: "approved", clientName: "Ada", comment: "Looks great" }
    );
    assert.equal(r.comment.author, "Ada");
    assert.ok(r.comment.text.startsWith("[approved]"));
    assert.match(r.comment.text, /Looks great/);
    assert.equal(r.eventKind, "share.approved");
    assert.match(r.eventSummary, /Client review: approved/);
    // No status field exists on the outcome: callers persist the comment
    // and event only, so no reviewer input can finalize a campaign.
    assert.deepEqual(Object.keys(r).sort(), ["comment", "eventKind", "eventSummary"]);
  });

  it("a change request records notes without moving status either", () => {
    const r = applyShareReviewDecision(
      { id: "cmp_x", title: "X" },
      { decision: "changes_requested", comment: "Swap the hero" }
    );
    assert.match(r.comment.text, /\[changes_requested\]/);
    assert.match(r.comment.text, /Swap the hero/);
    assert.equal(r.eventKind, "share.changes_requested");
    assert.match(r.eventSummary, /Client review: changes_requested/);
  });
});
