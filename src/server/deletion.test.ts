import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  applyArchiveToDb,
  applyDeleteToDb,
  CampaignNotFoundError,
  deletionEligibility,
  forceDeleteEligibility,
  forceDeleteWarnings
} from "./deletion";
import type { Campaign, Database } from "./types";

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

function draft(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: "cmp_test",
    title: "TEST draft",
    brand: "Verdi Steps",
    productName: "TerraRunner",
    request: {
      platform: "instagram",
      country: "GR",
      requestedClaims: [],
      transformation: "image",
      creativeBrief: "A sufficiently long creative brief for tests."
    },
    status: "draft",
    jobs: [],
    receipts: [],
    creatorId: "crt_1",
    sourceMediaId: "med_1",
    passportId: "pp_1",
    productFactsId: "pf_1",
    comments: [],
    captions: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("deletionEligibility", () => {
  it("allows deleting plain and blocked drafts", () => {
    for (const c of [draft(), draft({ status: "blocked" }), draft({ status: "review" })]) {
      const e = deletionEligibility(c);
      assert.equal(e.deletable, true);
      assert.equal(e.archiveAvailable, true);
      assert.equal(e.busy, false);
      assert.deepEqual(e.reasons, []);
    }
  });

  it("allows deleting campaigns whose jobs all failed (no assets produced)", () => {
    const c = draft({
      status: "generating",
      jobs: [
        {
          id: "job_1",
          campaignId: "cmp_test",
          stageId: "keyframe",
          kind: "text-to-image",
          capability: "flux-schnell",
          prompt: "p",
          status: "failed",
          error: "boom",
          startedAt: "t"
        }
      ]
    });
    assert.equal(deletionEligibility(c).deletable, true);
  });

  it("offers archive — never delete — for generated assets", () => {
    const withReceipt = draft({
      receipts: [
        {
          id: "rcp_1",
          campaignId: "cmp_test",
          jobId: "job_1",
          label: "keyframe",
          mediaType: "image",
          format: "9:16",
          outputUrl: "https://example.com/out.png",
          outputHash: "h",
          capability: "flux-schnell",
          promptHash: "p",
          claimsUsed: [],
          derivedFrom: { sourceMediaId: "med_1", passportId: "pp_1", productFactsId: "pf_1" },
          generatedAt: "t",
          visibility: "private"
        }
      ]
    });
    const e = deletionEligibility(withReceipt);
    assert.equal(e.deletable, false);
    assert.equal(e.archiveAvailable, true);
    assert.ok(e.reasons.join(" ").includes("generated assets"));

    const succeededJob = draft({
      jobs: [
        {
          id: "job_1",
          campaignId: "cmp_test",
          stageId: "keyframe",
          kind: "text-to-image",
          capability: "flux-schnell",
          prompt: "p",
          status: "ready_to_share",
          outputUrl: "https://example.com/out.png",
          startedAt: "t"
        }
      ]
    });
    assert.equal(deletionEligibility(succeededJob).deletable, false);
  });

  it("offers archive for share links and any finalized proof", () => {
    assert.equal(deletionEligibility(draft({ shareToken: "tok_1" })).deletable, false);
    assert.equal(deletionEligibility(draft({ publicationStatus: "anchored", campaignUAL: "did:dkg:otp:1/0xabc/1" })).deletable, false);
    assert.equal(deletionEligibility(draft({ campaignUAL: "did:dkg:otp:1/0xabc/1" })).deletable, false);
    assert.equal(deletionEligibility(draft({ verificationRef: "vrf_abc" })).deletable, false);
    for (const c of [
      draft({ shareToken: "tok_1" }),
      draft({ publicationStatus: "anchored", campaignUAL: "did:dkg:otp:1/0xabc/1" }),
      draft({ verificationRef: "vrf_abc" })
    ]) {
      const e = deletionEligibility(c);
      assert.equal(e.archiveAvailable, true);
      assert.ok(e.reasons.length > 0);
    }
  });

  it("blocks both operations while jobs are running", () => {
    for (const status of ["queued", "generating", "preview_ready", "storage_pending"] as const) {
      const c = draft({
        status: "generating",
        jobs: [
          {
            id: "job_1",
            campaignId: "cmp_test",
            stageId: "keyframe",
            kind: "text-to-image",
            capability: "flux-schnell",
            prompt: "p",
            status,
            startedAt: "t"
          }
        ]
      });
      const e = deletionEligibility(c);
      assert.equal(e.deletable, false);
      assert.equal(e.archiveAvailable, false);
      assert.equal(e.busy, true);
    }
  });

  it("never hard-deletes archived history", () => {
    const e = deletionEligibility(draft({ status: "archived" }));
    assert.equal(e.deletable, false);
    assert.equal(e.archiveAvailable, false);
    assert.ok(e.reasons.join(" ").includes("audit history"));
  });
});

describe("applyDeleteToDb", () => {
  it("removes the row, tombstones, keeps events, and is idempotent on retry", () => {
    const db = blankDb();
    db.campaigns.push(draft({ id: "cmp_gone", title: "Gone" }));
    const first = applyDeleteToDb(db, "cmp_gone", "t1", "evt_1");
    assert.deepEqual(first, { deleted: true, alreadyDeleted: false, title: "Gone" });
    assert.equal(db.campaigns.length, 0);
    assert.equal(db.deletedCampaigns.length, 1);
    assert.equal(db.events.filter((e) => e.kind === "campaign.deleted").length, 1);
    // Retry: success, nothing further happens — no duplicate tombstone/event.
    const second = applyDeleteToDb(db, "cmp_gone", "t2", "evt_2");
    assert.deepEqual(second, { deleted: true, alreadyDeleted: true, title: "Gone" });
    assert.equal(db.deletedCampaigns.length, 1);
    assert.equal(db.events.filter((e) => e.kind === "campaign.deleted").length, 1);
  });

  it("rejects unknown ids and tolerates legacy rows without tombstones", () => {
    assert.throws(() => applyDeleteToDb(blankDb(), "cmp_nope", "t", "evt_1"), CampaignNotFoundError);
    const legacy = blankDb() as Database;
    delete (legacy as Partial<Database>).deletedCampaigns;
    legacy.campaigns.push(draft({ id: "cmp_old" }));
    assert.equal(applyDeleteToDb(legacy, "cmp_old", "t", "evt_1").deleted, true);
    assert.equal(applyDeleteToDb(legacy, "cmp_old", "t", "evt_2").alreadyDeleted, true);
  });
});

describe("applyArchiveToDb", () => {  it("archives in place, keeps the row readable, and is idempotent on retry", () => {
    const db = blankDb();
    db.campaigns.push(draft({ id: "cmp_a", status: "approved" }));
    const first = applyArchiveToDb(db, "cmp_a", "t1", "evt_1");
    assert.deepEqual(first, { archived: true, alreadyArchived: false, title: "TEST draft" });
    assert.equal(db.campaigns[0].status, "archived");
    assert.equal(db.events.filter((e) => e.kind === "campaign.archived").length, 1);
    const second = applyArchiveToDb(db, "cmp_a", "t2", "evt_2");
    assert.deepEqual(second, { archived: true, alreadyArchived: true, title: "TEST draft" });
    assert.equal(db.events.filter((e) => e.kind === "campaign.archived").length, 1);
  });

  it("rejects unknown ids", () => {
    assert.throws(() => applyArchiveToDb(blankDb(), "cmp_nope", "t", "evt_1"), CampaignNotFoundError);
  });
});

describe("forceDeleteEligibility (archived last resort)", () => {
  it("allows force on settled archived records with explicit warnings", () => {
    const e = forceDeleteEligibility(draft({ status: "archived" }));
    assert.equal(e.allowed, true);
    assert.equal(e.busy, false);
    assert.ok(e.warnings.join(" ").includes("cannot be undone"));
  });

  it("warns about assets, share links and surviving public proof", () => {
    const warnings = forceDeleteWarnings(
      draft({
        status: "archived",
        receipts: [
          {
            id: "rcp_1",
            campaignId: "cmp_test",
            jobId: "job_1",
            label: "keyframe",
            mediaType: "image",
            format: "9:16",
            outputUrl: "https://example.com/out.png",
            outputHash: "h",
            capability: "flux-schnell",
            promptHash: "p",
            claimsUsed: [],
            derivedFrom: { sourceMediaId: "med_1", passportId: "pp_1", productFactsId: "pf_1" },
            generatedAt: "t",
            visibility: "private"
          }
        ],
        shareToken: "tok_1",
        verificationRef: "vrf_abc"
      })
    );
    const text = warnings.join(" ");
    assert.ok(text.includes("1 generated output"));
    assert.ok(text.includes("client-review link breaks"));
    assert.ok(text.includes("stay published and verifiable"));
  });

  it("still blocks force while jobs run, and rejects force on non-archived rows", () => {
    const busyArchived = draft({
      status: "archived",
      jobs: [
        {
          id: "job_1",
          campaignId: "cmp_test",
          stageId: "keyframe",
          kind: "text-to-image",
          capability: "flux-schnell",
          prompt: "p",
          status: "generating",
          startedAt: "t"
        }
      ]
    });
    const busy = forceDeleteEligibility(busyArchived);
    assert.equal(busy.allowed, false);
    assert.equal(busy.busy, true);
    const notArchived = forceDeleteEligibility(draft());
    assert.equal(notArchived.allowed, false);
    assert.ok(notArchived.reasons.join(" ").includes("only to archived records"));
  });

  it("applyDeleteToDb removes archived rows and tombstones them", () => {
    const db = blankDb();
    db.campaigns.push(draft({ id: "cmp_old", status: "archived", title: "Old" }));
    const res = applyDeleteToDb(db, "cmp_old", "t", "evt_1");
    assert.deepEqual(res, { deleted: true, alreadyDeleted: false, title: "Old" });
    assert.equal(db.campaigns.length, 0);
    assert.equal(applyDeleteToDb(db, "cmp_old", "t", "evt_2").alreadyDeleted, true);
  });
});

describe("deletion route authorization (static)", () => {
  const root = process.cwd();
  const read = (rel: string) => fs.readFileSync(path.join(root, ...rel.split("/")), "utf8");

  it("DELETE and archive routes are owner-gated, never anonymous", () => {
    const del = read("src/app/api/campaigns/[id]/route.ts");
    assert.ok(del.includes("deleteCampaign"), "DELETE handler delegates to deleteCampaign");
    assert.ok(del.includes("AuthenticationRequiredError"), "auth failures map to 401, never 500");
    assert.ok(del.includes("force"), "DELETE supports the flag-gated archived last resort");
    const archive = read("src/app/api/campaigns/[id]/archive/route.ts");
    assert.ok(archive.includes("archiveCampaign"), "archive route delegates to archiveCampaign");
    assert.ok(archive.includes("AuthenticationRequiredError"), "archive auth failures map to 401");
    const server = read("src/server/campaigns.ts");
    assert.ok(server.includes("requireWorkspaceOwner"), "delete/archive require the workspace owner");
    assert.ok(server.includes("ownerId"), "ownership is checked against the workspaces table");
  });

  it("deletion rules stay session-free (pure domain logic)", () => {
    const source = read("src/server/deletion.ts");
    for (const banned of ["loadDb", "updateDb", "requireCurrentSession", "next/headers", "cookies"]) {
      assert.ok(!source.includes(banned), `deletion.ts must not reference ${banned}`);
    }
  });
});
