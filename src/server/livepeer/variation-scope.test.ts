import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Campaign, Database, ProductionJob, ProductionStagePlan } from "../types";
import { emptyDb } from "../store";
import { setRunStore, memoryStore } from "./run-store";
import { cancelRunJobs, getRunStatusSnapshot, pumpRun, runOwnsJob, submitRun } from "./runner";
import { requestedPreservationMode, resolvePreservation } from "./preservation-policy";

/**
 * Variation execution-scoping regression (Prompt-4 correction).
 *
 * Bug: variation derivatives shared their original stageId, and every run
 * operation was stageId-scoped - dispatch picked the first matching job,
 * progress/ledger counted one entry per stage, and unrelated same-stage
 * jobs were reset/failed/cancelled by association.
 *
 * Fix: exact-job runs (ProductionRun.jobIds) own ONLY their listed jobs.
 * This file proves it end-to-end through submitRun + pumpRun with an
 * in-memory workspace and mocked fetch (synthetic HTTPS URLs, zero
 * network, zero spend):
 * - two variations dispatch as two create_variations calls with distinct
 *   stable idempotency keys, zero create_media calls;
 * - the original ready job and a stale same-stage queued decoy are never
 *   dispatched, reset, or otherwise touched;
 * - progress reads 2/2 with two distinct ledger entries/costs;
 * - cancelling one derivative leaves the other (and the run) intact;
 * - a stale variationSourceUrl without the explicit flag records guided
 *   generation, never variation.
 */

const SOURCE = "https://source.example/approved-creator.png";
const SQUARE_OUT = "https://cdn.example/square-11.png";
const VARIED_PREFIX = "https://cdn.example/varied-";
const IMAGE_CAP = "flux-dev";

function planStages(): ProductionStagePlan[] {
  return [
    { id: "keyframe", kind: "text-to-image", capability: IMAGE_CAP, label: "Campaign keyframe (9:16)", format: "9:16", dependsOnStageIds: [], inputSource: "approved-source", qualityProfile: "balanced", role: "conceptImage" },
    { id: "square", kind: "image-to-image", capability: IMAGE_CAP, label: "Square (1:1)", format: "1:1", dependsOnStageIds: [], inputSource: "approved-source", qualityProfile: "balanced", role: "sourceGuidedImage" }
  ];
}

function baseJob(stageId: string, id: string, status: ProductionJob["status"], extra: Partial<ProductionJob> = {}): ProductionJob {
  return {
    id,
    campaignId: "cmp_scope",
    stageId,
    kind: "image-to-image",
    capability: IMAGE_CAP,
    requestedCapability: IMAGE_CAP,
    qualityProfile: "balanced",
    role: "sourceGuidedImage",
    prompt: "still brief",
    status,
    startedAt: new Date().toISOString(),
    ...extra
  } as ProductionJob;
}

function originalJob(): ProductionJob {
  return baseJob("square", "job_orig", "ready_to_share", {
    providerOutputUrl: SQUARE_OUT,
    outputUrl: SQUARE_OUT,
    costUsd: 0.05,
    finishedAt: new Date().toISOString()
  });
}

function variationJob(id: string, n: number): ProductionJob {
  return baseJob("square", id, "queued", {
    prompt: `still brief Explicit variation ${n} of 2 from the selected completed output: keep the subject recognizable, vary composition and light.`,
    variationExplicit: true,
    variationSourceUrl: SQUARE_OUT
  });
}

/** Stale same-stage queued duplicate: must never be touched by the exact run. */
function decoyJob(): ProductionJob {
  return baseJob("square", "job_decoy", "queued", { prompt: "stale duplicate brief" });
}

function seedDb(jobs: ProductionJob[], run: Record<string, unknown> | null): Database {
  const db = emptyDb();
  db.sourceMedia.push({ id: "m1", creatorId: "c1", title: "approved creator media", type: "image", url: SOURCE, hash: "hash" });
  const campaign = {
    id: "cmp_scope",
    title: "scope pack",
    brand: "brand",
    productName: "product",
    request: {
      platform: "instagram",
      country: "GR",
      requestedClaims: [],
      transformation: "video",
      creativeBrief: "A sufficiently long creative brief for the scope probe.",
      qualityProfile: "balanced"
    },
    status: "generating",
    preflight: {
      decision: "allow",
      checkedAt: new Date().toISOString(),
      blockers: [],
      allowedClaims: [],
      promptConstraints: ["Be honest."],
      plan: planStages(),
      queriedRights: [],
      queriedFacts: [],
      sparqlPreview: ""
    },
    jobs,
    receipts: [],
    runs: run ? [{ id: "run_scope", campaignId: "cmp_scope", status: "active", maxConcurrency: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...run }] : [],
    creatorId: "c1",
    sourceMediaId: "m1",
    passportId: "p1",
    productFactsId: "f1",
    comments: [],
    captions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  } as unknown as Campaign;
  db.campaigns.push(campaign);
  return db;
}

/* Mocked provider: async create_variations per call, honest everything else. */
let seen: { tool: string; args: Record<string, unknown> }[];
let realFetch: typeof fetch | undefined;
let varyCounter = 0;

function stubProvider(): void {
  realFetch = globalThis.fetch;
  seen = [];
  varyCounter = 0;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    const ok = (structured: Record<string, unknown>, text = "") => ({
      result: { structuredContent: structured, content: text ? [{ type: "text", text }] : [] },
      jsonrpc: "2.0",
      id: "t"
    });
    const send = (payload: Record<string, unknown>) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    if (body.method === "initialize") return send(ok({ protocolVersion: "2025-03-26" }));
    if (body.method === "notifications/initialized") return send({});
    const tool = String(body.params?.name);
    const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
    if (tool === "list_capabilities") {
      return send(ok({ total: 1, capabilities: [{ name: IMAGE_CAP, kind: "ai", availability: "available", model_id: "", description: "" }] }));
    }
    if (tool === "get_pricing") return send(ok({ capabilities: [] }));
    seen.push({ tool, args });
    if (tool === "create_media") {
      varyCounter += 1;
      return send(ok({ job_id: `mjob_media_${varyCounter}`, status: "queued" }));
    }
    if (tool === "create_variations") {
      // Inline completion (the only shape dispatch finalizes - see note in
      // the dispatch test below): one distinct output per call.
      varyCounter += 1;
      return send(ok({ url: `${VARIED_PREFIX}${varyCounter}.png`, status: "completed", cost_paid_usd: 0.04 }));
    }
    if (tool === "get_create_media" || tool === "subscribe_progress") {
      const id = String(args.job_id ?? args.jobId ?? "");
      const n = id.startsWith("mjob_vary_") ? id.slice("mjob_vary_".length) : "0";
      return send(ok({ job_id: id, status: "completed", url: `${VARIED_PREFIX}${n}.png`, cost_paid_usd: 0.04 }));
    }
    if (tool === "cancel_job") {
      return send(ok({ status: "cancelled" }, "job cancelled"));
    }
    return send(ok({}));
  }) as typeof fetch;
}

function varyCalls(): Record<string, unknown>[] {
  return seen.filter((s) => s.tool === "create_variations").map((s) => s.args);
}

function mediaCalls(): Record<string, unknown>[] {
  return seen.filter((s) => s.tool === "create_media").map((s) => s.args);
}

const savedEnv: Record<string, string | undefined> = {};

describe("variation execution scoping", () => {
  before(() => {
    for (const k of ["DKG_MODE", "LIVEPEER_QUALITY_CHECK"]) savedEnv[k] = process.env[k];
    process.env.DKG_MODE = "__unsupported_test__";
    process.env.LIVEPEER_QUALITY_CHECK = "off";
    stubProvider();
  });

  after(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (realFetch) globalThis.fetch = realFetch;
    realFetch = undefined;
    setRunStore(null);
  });

  afterEach(() => {
    setRunStore(null);
  });

  function useStore(jobs: ProductionJob[], run: Record<string, unknown> | null) {
    seen = [];
    varyCounter = 0;
    const { store, read } = memoryStore(seedDb(jobs, run));
    setRunStore(store);
    return { read, ws: "ws1" };
  }

  function campaignOf(read: () => Database): Campaign {
    return read().campaigns.find((c) => c.id === "cmp_scope")!;
  }

  async function awaitSettled(read: () => Database, ids: string[], timeoutMs = 25000): Promise<void> {
    const start = Date.now();
    for (;;) {
      const jobs = campaignOf(read).jobs;
      if (ids.every((id) => { const s = jobs.find((j) => j.id === id)?.status; return s !== "queued" && s !== "generating"; })) return;
      if (Date.now() - start > timeoutMs) throw new Error(`jobs did not settle: ${ids.join(",")}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  it("submitRun creates an exact-job run addressing only the listed jobs", async () => {
    const { read, ws } = useStore([originalJob(), variationJob("job_v1", 1), variationJob("job_v2", 2), decoyJob()], null);
    const submitted = await submitRun({ campaignId: "cmp_scope", jobIds: ["job_v1", "job_v2"], workspaceId: ws });
    assert.equal(submitted.created, true);
    assert.deepEqual(submitted.run?.jobIds, ["job_v1", "job_v2"]);
    // Informational stage cover only: no records created, no sibling reset.
    assert.deepEqual(submitted.run?.stageIds, ["square"]);
    const campaign = campaignOf(read);
    assert.equal(campaign.jobs.length, 4, "exact submit creates no job records");
    assert.equal(campaign.jobs.find((j) => j.id === "job_decoy")?.status, "queued");
  });

  it("two variations dispatch as two create_variations calls; original and decoy untouched", async () => {
    const { read, ws } = useStore(
      [originalJob(), variationJob("job_v1", 1), variationJob("job_v2", 2), decoyJob()],
      { stageIds: ["square"], jobIds: ["job_v1", "job_v2"] }
    );
    const pumped = await pumpRun(ws, "cmp_scope", { runId: "run_scope", budgetMs: 30000 });
    assert.equal(pumped.pumped, true);
    await awaitSettled(read, ["job_v1", "job_v2"]);

    // Exactly two variation calls with distinct stable idempotency keys.
    const calls = varyCalls();
    assert.equal(calls.length, 2);
    const keys = calls.map((a) => String(a.idempotency_key));
    assert.equal(new Set(keys).size, 2, "distinct provider keys");
    assert.ok(keys.every((k) => k.endsWith("_vary")), "operation-suffixed stable keys");
    assert.notEqual(keys[0], keys[1]);
    for (const call of calls) {
      assert.equal(call.source_url, SQUARE_OUT, "each derivative varies the selected completed output");
    }
    // Zero provider calls for anything else: no guided re-render, no decoy.
    assert.equal(mediaCalls().length, 0, "no unintended create_media calls");

    const campaign = campaignOf(read);
    const orig = campaign.jobs.find((j) => j.id === "job_orig")!;
    assert.equal(orig.status, "ready_to_share", "original stays delivered");
    assert.equal(orig.livepeerJobId, undefined, "original never re-dispatched");
    assert.equal(orig.costUsd, 0.05, "original cost unchanged");
    const decoy = campaign.jobs.find((j) => j.id === "job_decoy")!;
    assert.equal(decoy.status, "queued", "stale same-stage queued job never selected");
    assert.equal(decoy.livepeerJobId, undefined, "decoy holds no provider id");

    // Provenance: what actually ran, per derivative.
    for (const id of ["job_v1", "job_v2"]) {
      const j = campaign.jobs.find((x) => x.id === id)!;
      assert.equal(j.status, "ready_to_share");
      assert.equal(j.requestMeta?.preservationRequested, "variation");
      assert.equal(j.requestMeta?.preservationResolved, "variation");
      assert.equal(j.requestMeta?.preservationActualCapability, "create_variations");
      assert.equal(j.requestMeta?.providerOperationSucceeded, true);
    }
    const receipts = campaign.receipts.filter((r) => r.jobId === "job_v1" || r.jobId === "job_v2");
    assert.equal(receipts.length, 2);
    for (const r of receipts) {
      assert.equal(r.preservationResolved, "variation");
      assert.equal(r.preservationActualCapability, "create_variations");
    }

    // Run completion, progress, and ledger show two derivatives, not one stage.
    const run = campaign.runs?.find((r) => r.id === "run_scope");
    assert.equal(run?.status, "complete");
    const snapshot = await getRunStatusSnapshot(ws, "cmp_scope", "run_scope");
    assert.deepEqual(snapshot?.progress, { ready: 2, total: 2 });
    assert.equal(snapshot?.stages.length, 2, "ledger carries one entry per derivative job");
    const costs = (snapshot?.stages ?? []).map((s) => s.costUsd);
    assert.deepEqual(costs, [0.04, 0.04], "two distinct job costs");
    assert.equal(snapshot?.actualTotal, 0.08);
    assert.ok(!(snapshot?.jobs ?? []).some((j) => j.id === "job_decoy"), "decoy excluded from run jobs");
  });

  it("cancelling one derivative leaves the other and the run intact", async () => {
    const { read, ws } = useStore(
      [originalJob(), variationJob("job_v1", 1), variationJob("job_v2", 2)],
      { stageIds: ["square"], jobIds: ["job_v1", "job_v2"] }
    );
    const cancelled = await cancelRunJobs(ws, "cmp_scope", ["job_v1"]);
    assert.equal(cancelled.find((r) => r.jobId === "job_v1")?.outcome, "cancelled");
    const pumped = await pumpRun(ws, "cmp_scope", { runId: "run_scope", budgetMs: 30000 });
    assert.equal(pumped.pumped, true);
    await awaitSettled(read, ["job_v1", "job_v2"]);

    // Only the surviving derivative dispatched.
    assert.equal(varyCalls().length, 1);
    assert.equal(mediaCalls().length, 0);
    const campaign = campaignOf(read);
    assert.equal(campaign.jobs.find((j) => j.id === "job_v1")?.status, "cancelled");
    assert.equal(campaign.jobs.find((j) => j.id === "job_v1")?.livepeerJobId, undefined);
    assert.equal(campaign.jobs.find((j) => j.id === "job_v2")?.status, "ready_to_share");
    // Ownership predicate: the run never owned anything but its two ids.
    const run = campaign.runs?.find((r) => r.id === "run_scope");
    assert.ok(run, "exact run exists");
    assert.equal(runOwnsJob(run, { id: "job_v1", stageId: "square" }), true);
    assert.equal(runOwnsJob(run, { id: "job_decoy", stageId: "square" }), false);
  });

  it("legacy stage-scoped runs keep stage/DAG behavior (decoy IS selected)", async () => {
    // Documents the collision exact scope exists to avoid: without jobIds,
    // first-match-by-stage picks the stale queued duplicate.
    const { read, ws } = useStore(
      [originalJob(), decoyJob()],
      { stageIds: ["square"] }
    );
    await pumpRun(ws, "cmp_scope", { runId: "run_scope", budgetMs: 20000 });
    assert.equal(mediaCalls().length, 1, "stage scope dispatches the queued same-stage job");
    assert.ok(campaignOf(read).jobs.find((j) => j.id === "job_decoy")?.livepeerJobId, "decoy holds a provider id under stage scope");
    const snapshot = await getRunStatusSnapshot(ws, "cmp_scope", "run_scope");
    assert.equal(snapshot?.progress.total, 1, "stage progress counts stages, not jobs");
  });

  it("stale variationSourceUrl without the explicit flag records guided generation, never variation", () => {
    assert.equal(
      requestedPreservationMode({ role: "sourceGuidedImage", variationExplicit: false, variationSourceUrl: SQUARE_OUT }),
      "source-guided-generation"
    );
    const d = resolvePreservation({
      stageId: "square",
      kind: "image-to-image",
      role: "sourceGuidedImage",
      sourceUrl: SOURCE,
      sourceAssetId: "m1",
      sourceOwnedByCampaign: true,
      rightsAllowed: true,
      variationExplicit: false,
      variationSourceUrl: SQUARE_OUT,
      placeSubjectMode: "auto"
    });
    assert.equal(d.requested, "source-guided-generation");
    assert.equal(d.resolved, "source-guided-generation");
    assert.equal(d.fallbackReason, undefined);
    assert.equal(d.refusal, undefined);
  });
});
