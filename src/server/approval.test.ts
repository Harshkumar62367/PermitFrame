import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Campaign, DerivativeReceipt, PermissionPassport, ProductionJob, ProductionStagePlan } from "./types";
import { checkApprovalEligibility } from "./campaign-lifecycle";
import type { AuthorizationRevalidation } from "./policy/authorization";

/**
 * Owner-approval gate composition (pure): effective verdict, current exact
 * authorization, production readiness, durable identity, aspect honesty,
 * and at least one public deliverable output. No database, no DKG, no
 * provider - approveCampaign supplies live evidence for the same composer.
 */

function receipt(over: Partial<DerivativeReceipt> = {}): DerivativeReceipt {
  return {
    id: "rcpt_1",
    campaignId: "cmp_appr",
    jobId: "job_1",
    label: "Campaign keyframe (9:16)",
    mediaType: "image",
    format: "9:16",
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
    campaignId: "cmp_appr",
    stageId: "keyframe",
    kind: "text-to-image",
    capability: "flux-dev",
    prompt: "p",
    status: "ready_to_share",
    startedAt: new Date().toISOString(),
    ...over
  } as ProductionJob;
}

function campaign(
  over: Partial<Pick<Campaign, "status" | "preflight" | "jobs" | "receipts" | "passportId">> = {}
): Pick<Campaign, "status" | "preflight" | "jobs" | "receipts" | "passportId"> {
  return {
    status: "review",
    preflight: { decision: "allow" } as Campaign["preflight"],
    jobs: [job()],
    receipts: [receipt()],
    passportId: "pp1",
    ...over
  };
}

function planStage(id: string): ProductionStagePlan {
  return {
    id,
    kind: "text-to-image",
    capability: "flux-dev",
    label: `Stage ${id}`,
    format: "1:1",
    dependsOnStageIds: [],
    inputSource: "approved-source",
    qualityProfile: "balanced",
    role: "conceptImage"
  };
}

function allowedPreflight(plan: ProductionStagePlan[] = []): Campaign["preflight"] {
  return {
    decision: "allow",
    checkedAt: "2026-01-01T00:00:00.000Z",
    blockers: [],
    allowedClaims: [],
    promptConstraints: [],
    plan,
    queriedRights: [],
    queriedFacts: [],
    sparqlPreview: ""
  };
}

function authOk(): AuthorizationRevalidation {
  return { ok: true, passport: { id: "pp1" } as PermissionPassport };
}

describe("approval eligibility", () => {
  it("stays possible when verdict, authorization, readiness, and deliverability all pass", () => {
    assert.deepEqual(checkApprovalEligibility(campaign(), authOk()), { ok: true });
  });

  it("blocks on an effective blocked verdict", () => {
    const r = checkApprovalEligibility(
      campaign({ preflight: { decision: "block" } as Campaign["preflight"] }),
      authOk()
    );
    assert.deepEqual(r, { ok: false, error: "Blocked campaigns cannot be approved" });
  });

  it("passes authorization failures through with their message", () => {
    const auth: AuthorizationRevalidation = { ok: false, error: "Permission passport pp1 has been revoked - request a fresh consent to continue." };
    assert.deepEqual(checkApprovalEligibility(campaign(), auth), { ok: false, error: auth.error });
  });

  it("requires produced jobs and durable outputs with exact historical copy", () => {
    assert.deepEqual(checkApprovalEligibility(campaign({ jobs: [] }), authOk()), {
      ok: false,
      error: "Produce the campaign pack before approving - previews and unsaved outputs cannot be signed off yet"
    });
    assert.deepEqual(
      checkApprovalEligibility(campaign({ receipts: [receipt({ storageStatus: "pending" })] }), authOk()),
      {
        ok: false,
        error: "Store outputs securely before approving - provider-hosted legacy assets cannot be published as proof yet"
      }
    );
  });

  it("names aspect-mismatched stages", () => {
    const r = checkApprovalEligibility(
      campaign({
        receipts: [receipt({ aspectVerdict: "mismatch", actualWidth: 1024, actualHeight: 768 })]
      }),
      authOk()
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /Aspect check failed/);
    assert.match(r.error, /Campaign keyframe/);
  });

  it("refuses packs whose only outputs are private derivatives", () => {
    const r = checkApprovalEligibility(
      campaign({ receipts: [receipt({ visibility: "private" })] }),
      authOk()
    );
    assert.deepEqual(r, {
      ok: false,
      error: "Only deliverable shared outputs can be approved - private, blocked, or not-yet-stored outputs cannot be signed off."
    });
  });

  it("blocks when a planned job is queued, generating, or previewing", () => {
    const plan = allowedPreflight([planStage("keyframe"), planStage("square")]);
    for (const status of ["queued", "generating", "preview_ready", "storage_pending", "storage_retry_needed"] as const) {
      const r = checkApprovalEligibility(
        campaign({
          preflight: plan,
          jobs: [job({ id: "j1", stageId: "keyframe", status: "ready_to_share" }), job({ id: "j2", stageId: "square", status })]
        }),
        authOk()
      );
      assert.equal(r.ok, false, `status ${status} must block`);
      if (r.ok) continue;
      assert.match(r.error, /Cannot approve - 1 planned stage is not ready/);
      assert.match(r.error, new RegExp(`Stage square.*\\(${status}\\)`));
    }
  });

  it("blocks on failed or cancelled planned jobs, naming the stage", () => {
    for (const status of ["failed", "cancelled"] as const) {
      const r = checkApprovalEligibility(
        campaign({
          preflight: allowedPreflight([planStage("keyframe")]),
          jobs: [job({ stageId: "keyframe", status })]
        }),
        authOk()
      );
      assert.equal(r.ok, false);
      if (r.ok) continue;
      assert.match(r.error, /Stage keyframe/);
      assert.match(r.error, /Wait for completion or regenerate/);
    }
  });

  it("blocks a planned stage with no job at all", () => {
    const r = checkApprovalEligibility(
      campaign({
        preflight: allowedPreflight([planStage("keyframe"), planStage("square")]),
        jobs: [job({ stageId: "keyframe", status: "ready_to_share" })]
      }),
      authOk()
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /not produced/);
  });

  it("succeeds when every active-plan job is ready with a deliverable output", () => {
    const r = checkApprovalEligibility(
      campaign({
        preflight: allowedPreflight([planStage("keyframe"), planStage("square")]),
        jobs: [
          job({ id: "j1", stageId: "keyframe", status: "ready_to_share" }),
          job({ id: "j2", stageId: "square", status: "ready_to_share" })
        ]
      }),
      authOk()
    );
    assert.deepEqual(r, { ok: true });
  });

  it("a non-plan legacy job never blocks approval", () => {
    const r = checkApprovalEligibility(
      campaign({
        preflight: allowedPreflight([planStage("keyframe")]),
        jobs: [
          job({ id: "j1", stageId: "keyframe", status: "ready_to_share" }),
          job({ id: "j-old", stageId: "retired-stage", status: "failed" })
        ]
      }),
      authOk()
    );
    assert.deepEqual(r, { ok: true });
  });

  it("rejects authorization bound to an earlier selection", () => {
    const staleAuth: AuthorizationRevalidation = { ok: true, passport: { id: "pp_old" } as PermissionPassport };
    const r = checkApprovalEligibility(campaign({ passportId: "pp_new" }), staleAuth);
    assert.deepEqual(r, {
      ok: false,
      error: "Authorization does not match the current campaign selection - re-check permissions before approving."
    });
  });
});
