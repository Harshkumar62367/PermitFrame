import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Campaign, ProductionJob } from "./types";
import * as facade from "./campaigns";
import {
  loadCampaign, requireWorkspaceOwner, throwIfArchived, createCampaign,
  createCampaignIdempotent, rePreflight, updateCampaignBrief, approveCampaign,
  deleteCampaign, refreshVerificationSnapshot, archiveCampaign
} from "./campaign-lifecycle";
import {
  ACTIVE_JOB_STATUSES, checkTemplateApplyReadiness, applyTemplateSpec
} from "./campaign-template-application";
import { startProduction, cancelCampaignJobs } from "./campaign-production";
import { reviseStage, createVariationRun } from "./campaign-variations";

/**
 * Campaign façade compatibility after the campaigns.ts modularization
 * (lifecycle / template-application / production / variations behind a
 * 31-line façade).
 *
 * - Every public name still resolves through "./campaigns" and is
 *   reference-identical to the extracted implementation (catches wiring
 *   mistakes - the highest refactor risk).
 * - Pure gates pin the highest-risk refusal rules without a session or
 *   ledger: archived read-only enforcement, template-apply history safety
 *   (delivered/failed/preview rows are never "active"), and the settled
 *   statuses variations may start from.
 * - Session/DB-gated flows (submit idempotency, exact-job runs, blocked /
 *   entitlement / cap refusals) moved verbatim; the unchanged full suite
 *   guards them.
 */

function job(status: ProductionJob["status"]): ProductionJob {
  return { id: `job_${status}`, stageId: "square", status } as ProductionJob;
}

describe("façade identity: every export resolves to the extracted implementation", () => {
  it("functions are identical references", () => {
    assert.equal(facade.loadCampaign, loadCampaign);
    assert.equal(facade.requireWorkspaceOwner, requireWorkspaceOwner);
    assert.equal(facade.throwIfArchived, throwIfArchived);
    assert.equal(facade.createCampaign, createCampaign);
    assert.equal(facade.createCampaignIdempotent, createCampaignIdempotent);
    assert.equal(facade.rePreflight, rePreflight);
    assert.equal(facade.updateCampaignBrief, updateCampaignBrief);
    assert.equal(facade.approveCampaign, approveCampaign);
    assert.equal(facade.deleteCampaign, deleteCampaign);
    assert.equal(facade.refreshVerificationSnapshot, refreshVerificationSnapshot);
    assert.equal(facade.archiveCampaign, archiveCampaign);
    assert.equal(facade.checkTemplateApplyReadiness, checkTemplateApplyReadiness);
    assert.equal(facade.applyTemplateSpec, applyTemplateSpec);
    assert.equal(facade.startProduction, startProduction);
    assert.equal(facade.cancelCampaignJobs, cancelCampaignJobs);
    assert.equal(facade.reviseStage, reviseStage);
    assert.equal(facade.createVariationRun, createVariationRun);
  });

  it("shared constants are identical references", () => {
    assert.equal(facade.ACTIVE_JOB_STATUSES, ACTIVE_JOB_STATUSES);
    assert.deepEqual([...facade.ACTIVE_JOB_STATUSES].sort(), ["generating", "preview_ready", "queued", "storage_pending"]);
  });
});

describe("archived read-only gate (blocked flows refuse exactly)", () => {
  it("archived campaigns throw for every mutating action", () => {
    const archived = { title: "Old pack", status: "archived" } as Campaign;
    for (const action of ["edited", "produced", "revised", "varied", "approved", "re-planned", "re-checked", "cancelled in"]) {
      assert.throws(() => facade.throwIfArchived(archived, action), /Archived campaigns are read-only/);
    }
  });

  it("non-archived campaigns pass through untouched", () => {
    for (const status of ["draft", "blocked", "generating", "review", "approved"] as Campaign["status"][]) {
      assert.doesNotThrow(() => facade.throwIfArchived({ title: "Live", status } as Campaign, "edited"));
    }
  });
});

describe("template-apply history safety (prior jobs preserved)", () => {
  it("refuses while any live job exists, naming the wait", () => {
    for (const status of ["queued", "generating", "preview_ready", "storage_pending"] as ProductionJob["status"][]) {
      const reason = facade.checkTemplateApplyReadiness({ jobs: [job(status)] } as Pick<Campaign, "jobs">);
      assert.match(reason ?? "", /Wait for active generation to finish/);
    }
  });

  it("settled history is never active: delivered, failed, cancelled, retry-rows pass", () => {
    const history = [
      job("ready_to_share"),
      job("failed"),
      job("cancelled"),
      job("storage_retry_needed")
    ];
    assert.equal(facade.checkTemplateApplyReadiness({ jobs: history } as Pick<Campaign, "jobs">), null);
  });

  it("mixed rows refuse when any single row is live", () => {
    const mixed = [job("ready_to_share"), job("failed"), job("generating")];
    assert.match(
      facade.checkTemplateApplyReadiness({ jobs: mixed } as Pick<Campaign, "jobs">) ?? "",
      /Wait for active generation/
    );
  });

  it("empty job list is ready", () => {
    assert.equal(facade.checkTemplateApplyReadiness({ jobs: [] }), null);
  });
});
