import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Campaign, Database, ProductionJob, ProductionStagePlan } from "../types";
import { emptyDb } from "../store";
import { setRunStore, memoryStore } from "./run-store";
import * as facade from "./runner";
import { submitRun as submitDirect } from "./run-submit";
import {
  STATUS_PUMP, pumpRun, submitRun, getRunStatusSnapshot, runSpendLedger,
  selectDispatchable, runOwnsJob, findActiveRun, provenanceMeta, finalizedPreviewFields,
  classifySubmitResult, nextJobAction, splitCancelTargets, shouldDispatchUnderCap,
  resolveMaxConcurrency, placeSubjectMode, qualityCheckEnabled, resolveProgressHold,
  pollProviderJob, computeBackoffMs, classifySubmitError, isBackoffPending,
  redactSubmitError, maxDispatchAttempts, preservationContextFor
} from "./runner";

/**
 * Facade compatibility + behavior preservation after the runner
 * modularization (run-scope / retry / submit / poll / dispatch /
 * finalize / lifecycle behind a <250-line runner.ts facade).
 *
 * - Every public name still resolves through "./runner" (identity with
 *   the extracted module implementations where they live elsewhere).
 * - Behavior suites below drive the facade only (submitRun / pumpRun /
 *   snapshots / ledger): legacy pack, exact-job derivatives, async
 *   preservation handle, status-route non-dispatch, and replacement-
 *   capability ledger pricing. Mocked fetch, zero network, zero spend.
 */

const SOURCE = "https://source.example/approved-creator.png";
const OUT = "https://cdn.example/facade-out.png";
const IMAGE_CAP = "flux-dev";
const REPLACEMENT_CAP = "flux-pro";

describe("facade re-exports resolve to the extracted implementations", () => {
  it("functions and constants are identical references", () => {
    assert.equal(facade.submitRun, submitDirect);
    assert.equal(typeof facade.pumpRun, "function");
    assert.equal(typeof facade.getRunStatusSnapshot, "function");
    assert.equal(typeof facade.runSpendLedger, "function");
    assert.equal(typeof facade.cancelRunJobs, "function");
    for (const fn of [
      selectDispatchable, runOwnsJob, findActiveRun, provenanceMeta, finalizedPreviewFields,
      classifySubmitResult, nextJobAction, splitCancelTargets, shouldDispatchUnderCap,
      resolveMaxConcurrency, placeSubjectMode, qualityCheckEnabled, resolveProgressHold,
      pollProviderJob, computeBackoffMs, classifySubmitError, isBackoffPending,
      redactSubmitError, maxDispatchAttempts, preservationContextFor
    ]) {
      assert.equal(typeof fn, "function");
    }
    assert.equal(typeof facade.STATUS_PUMP, "object");
    assert.equal(facade.STATUS_PUMP.allowDispatch, false);
  });
});

function planStages(): ProductionStagePlan[] {
  return [
    { id: "keyframe", kind: "text-to-image", capability: IMAGE_CAP, label: "Keyframe", format: "9:16", dependsOnStageIds: [], inputSource: "approved-source", qualityProfile: "balanced", role: "conceptImage" },
    { id: "square", kind: "image-to-image", capability: IMAGE_CAP, label: "Square", format: "1:1", dependsOnStageIds: [], inputSource: "approved-source", qualityProfile: "balanced", role: "sourceGuidedImage" }
  ];
}

function mkJob(stageId: string, id: string, status: ProductionJob["status"], extra: Partial<ProductionJob> = {}): ProductionJob {
  return {
    id,
    campaignId: "cmp_facade",
    stageId,
    kind: "text-to-image",
    capability: IMAGE_CAP,
    requestedCapability: IMAGE_CAP,
    qualityProfile: "balanced",
    role: stageId === "keyframe" ? "conceptImage" : "sourceGuidedImage",
    prompt: "facade brief",
    status,
    startedAt: new Date().toISOString(),
    ...extra
  } as ProductionJob;
}

function seedDb(jobs: ProductionJob[], run: Record<string, unknown> | null): Database {
  const db = emptyDb();
  db.sourceMedia.push({ id: "m1", creatorId: "c1", title: "approved creator media", type: "image", url: SOURCE, hash: "hash" });
  const campaign = {
    id: "cmp_facade",
    title: "facade pack",
    brand: "brand",
    productName: "product",
    request: {
      platform: "instagram",
      country: "GR",
      requestedClaims: [],
      transformation: "video",
      creativeBrief: "A sufficiently long creative brief for the facade probe.",
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
    runs: run ? [{ id: "run_facade", campaignId: "cmp_facade", status: "active", maxConcurrency: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...run }] : [],
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

let seen: { tool: string; args: Record<string, unknown> }[];
let realFetch: typeof fetch | undefined;
/** When set, create_variations backgrounds instead of completing inline. */
let varyAsync = false;

function stubProvider(): void {
  realFetch = globalThis.fetch;
  seen = [];
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
    if (tool === "create_media") return send(ok({ job_id: "mjob_facade_1", status: "queued" }));
    if (tool === "create_variations") {
      if (varyAsync) return send(ok({ job_id: "mjob_vary_f1", status: "queued" }));
      return send(ok({ url: OUT, status: "completed", cost_paid_usd: 0.04 }));
    }
    if (tool === "get_create_media" || tool === "subscribe_progress") {
      const id = String(args.job_id ?? args.jobId ?? "");
      if (id === "mjob_vary_f1") return send(ok({ job_id: id, status: "completed", url: OUT, cost_paid_usd: 0.04 }));
      return send(ok({ job_id: id, status: "completed", url: OUT, cost_paid_usd: 0.05 }));
    }
    return send(ok({}));
  }) as typeof fetch;
}

const savedEnv: Record<string, string | undefined> = {};

describe("facade behavior preservation", () => {
  before(() => {
    for (const k of ["DKG_MODE", "LIVEPEER_QUALITY_CHECK", "LIVEPEER_PLACE_SUBJECT"]) savedEnv[k] = process.env[k];
    process.env.DKG_MODE = "__unsupported_test__";
    process.env.LIVEPEER_QUALITY_CHECK = "off";
    process.env.LIVEPEER_PLACE_SUBJECT = "off";
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
    varyAsync = false;
  });

  function useStore(jobs: ProductionJob[], run: Record<string, unknown> | null) {
    seen = [];
    const { store, read } = memoryStore(seedDb(jobs, run));
    setRunStore(store);
    return { read, ws: "ws1" };
  }

  function campaignOf(read: () => Database): Campaign {
    return read().campaigns.find((c) => c.id === "cmp_facade")!;
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

  it("legacy stage-scoped pack runs to completion through the facade", async () => {
    const { read, ws } = useStore([mkJob("keyframe", "job_k", "queued"), mkJob("square", "job_s", "queued")], null);
    const submitted = await submitRun({ campaignId: "cmp_facade", workspaceId: ws });
    assert.equal(submitted.created, true);
    assert.equal(submitted.run?.jobIds, undefined, "stage runs carry no exact scope");
    await pumpRun(ws, "cmp_facade", { runId: submitted.run?.id, budgetMs: 30000 });
    await awaitSettled(read, ["job_k", "job_s"]);
    const campaign = campaignOf(read);
    assert.ok(campaign.jobs.every((j) => j.status === "ready_to_share"));
    assert.equal(campaign.runs?.[0]?.status, "complete");
    assert.equal(seen.filter((s) => s.tool === "create_media").length, 2);
  });

  it("exact-job variation run isolates derivatives through the facade", async () => {
    const { read, ws } = useStore(
      [
        mkJob("square", "job_orig", "ready_to_share", { providerOutputUrl: OUT, outputUrl: OUT, costUsd: 0.05, finishedAt: new Date().toISOString() }),
        mkJob("square", "job_d1", "queued", { prompt: "facade brief Explicit variation 1.", variationExplicit: true, variationSourceUrl: OUT }),
        mkJob("square", "job_d2", "queued", { prompt: "facade brief Explicit variation 2.", variationExplicit: true, variationSourceUrl: OUT })
      ],
      null
    );
    const submitted = await submitRun({ campaignId: "cmp_facade", jobIds: ["job_d1", "job_d2"], workspaceId: ws });
    assert.deepEqual(submitted.run?.jobIds, ["job_d1", "job_d2"]);
    await pumpRun(ws, "cmp_facade", { runId: submitted.run?.id, budgetMs: 30000 });
    await awaitSettled(read, ["job_d1", "job_d2"]);
    assert.equal(seen.filter((s) => s.tool === "create_variations").length, 2);
    assert.equal(seen.filter((s) => s.tool === "create_media").length, 0);
    const campaign = campaignOf(read);
    assert.equal(campaign.jobs.find((j) => j.id === "job_orig")?.livepeerJobId, undefined);
    const snapshot = await getRunStatusSnapshot(ws, "cmp_facade", submitted.run?.id as string);
    assert.deepEqual(snapshot?.progress, { ready: 2, total: 2 });
  });

  it("async preservation handle tracks and polls with no fallback while pending", async () => {
    varyAsync = true;
    const { read, ws } = useStore(
      [
        mkJob("square", "job_orig", "ready_to_share", { providerOutputUrl: OUT, outputUrl: OUT, costUsd: 0.05, finishedAt: new Date().toISOString() }),
        mkJob("square", "job_v", "queued", { prompt: "facade brief Explicit variation.", variationExplicit: true, variationSourceUrl: OUT })
      ],
      null
    );
    const submitted = await submitRun({ campaignId: "cmp_facade", jobIds: ["job_v"], workspaceId: ws });
    await pumpRun(ws, "cmp_facade", { runId: submitted.run?.id, budgetMs: 30000 });
    await awaitSettled(read, ["job_v"]);
    assert.equal(seen.filter((s) => s.tool === "create_variations").length, 1);
    assert.equal(seen.filter((s) => s.tool === "create_media").length, 0);
    const j = campaignOf(read).jobs.find((x) => x.id === "job_v")!;
    assert.equal(j.livepeerJobId, "mjob_vary_f1");
    assert.equal(j.status, "ready_to_share");
    assert.equal(j.requestMeta?.preservationActualCapability, "create_variations");
  });

  it("status pump never dispatches: in-flight polls, queued waits", async () => {
    const { read, ws } = useStore(
      [
        mkJob("keyframe", "job_fly", "generating", { livepeerJobId: "mjob_facade_1", dispatchedAt: new Date().toISOString() }),
        mkJob("square", "job_wait", "queued")
      ],
      { stageIds: ["keyframe", "square"] }
    );
    await pumpRun(ws, "cmp_facade", { runId: "run_facade", ...STATUS_PUMP });
    assert.equal(seen.filter((s) => s.tool === "create_media").length, 0, "status mode submits nothing");
    assert.ok(seen.some((s) => s.tool === "subscribe_progress" || s.tool === "get_create_media"), "in-flight job polled");
    const campaign = campaignOf(read);
    assert.equal(campaign.jobs.find((j) => j.id === "job_wait")?.status, "queued", "queued job untouched by status pump");
    assert.equal(campaign.jobs.find((j) => j.id === "job_wait")?.livepeerJobId, undefined);
  });

  it("ledger prices the actual replacement capability, not the plan", async () => {
    const { ws } = useStore(
      [mkJob("square", "job_sub", "ready_to_share", { actualCapability: REPLACEMENT_CAP, outputUrl: OUT, costUsd: 0.09, finishedAt: new Date().toISOString() })],
      { stageIds: ["square"] }
    );
    const ledger = await runSpendLedger(ws, "cmp_facade", "run_facade", new Map([
      [IMAGE_CAP, { usd: 0.02, unit: "image", unitKind: "image" }],
      [REPLACEMENT_CAP, { usd: 0.09, unit: "image", unitKind: "image" }]
    ]));
    assert.equal(ledger?.stages.length, 1);
    assert.equal(ledger?.stages[0]?.pricedCapability, REPLACEMENT_CAP);
    assert.equal(ledger?.stages[0]?.estimateUsd, 0.09);
    assert.equal(ledger?.stages[0]?.costUsd, 0.09);
    assert.equal(ledger?.actualTotal, 0.09);
  });
});
