import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Campaign, Database, ProductionJob, ProductionStagePlan } from "../types";
import { emptyDb } from "../store";
import { setRunStore, memoryStore } from "./run-store";
import { pumpRun, STATUS_PUMP } from "./runner";

/**
 * Recovery regression test (Prompt-3 review, Fix 4) - real pumpRun
 * integration, not decision composition.
 *
 * A broad `git checkout` once reverted the DAG executor while uncommitted;
 * this file proves the behavior end-to-end through pumpRun with an
 * in-memory workspace and mocked fetch (synthetic HTTPS URLs, zero
 * network, zero spend):
 * - independent stills each receive the approved source URL;
 * - motion receives only its declared keyframe output;
 * - a preview_ready dependency URL resumes motion after a restart;
 * - profile/role/requested-capability/resolved-input provenance lands on
 *   durable job rows;
 * - inline completion finalizes without redispatch;
 * - a failed still blocks only its dependent, never its siblings;
 * - status mode never calls create_media; detached mode does.
 */

const SOURCE = "https://source.example/approved-creator.png";
const KEYFRAME_OUT = "https://cdn.example/keyframe-916.png";
const SQUARE_OUT = "https://cdn.example/square-11.png";
const HEADER_OUT = "https://cdn.example/header-169.png";
const MOTION_OUT = "https://cdn.example/motion-916.mp4";
const INLINE_OUT = "https://cdn.example/inline.png";

const IMAGE_CAP = "flux-dev";
const MOTION_CAP = "kling-v3-turbo-i2v";

function planStages(): ProductionStagePlan[] {
  return [
    { id: "keyframe", kind: "text-to-image", capability: IMAGE_CAP, label: "Campaign keyframe (9:16)", format: "9:16", dependsOnStageIds: [], inputSource: "approved-source", qualityProfile: "balanced", role: "conceptImage" },
    { id: "square", kind: "image-to-image", capability: IMAGE_CAP, label: "Square (1:1)", format: "1:1", dependsOnStageIds: [], inputSource: "approved-source", qualityProfile: "balanced", role: "sourceGuidedImage" },
    { id: "header", kind: "image-to-image", capability: IMAGE_CAP, label: "Header (16:9)", format: "16:9", dependsOnStageIds: [], inputSource: "approved-source", qualityProfile: "balanced", role: "sourceGuidedImage" },
    { id: "motion", kind: "image-to-video", capability: MOTION_CAP, label: "Motion (9:16)", format: "9:16", dependsOnStageIds: ["keyframe"], inputSource: "stage-output", qualityProfile: "balanced", role: "imageToVideo", durationSeconds: 5, requestedDurationSeconds: 5, durationSource: "product-range-unverified" }
  ];
}

function mkJob(stageId: string, status: ProductionJob["status"], extra: Partial<ProductionJob> = {}): ProductionJob {
  const motion = stageId === "motion";
  return {
    id: `job_${stageId}`,
    campaignId: "cmp1",
    stageId,
    kind: motion ? "image-to-video" : "text-to-image",
    capability: motion ? MOTION_CAP : IMAGE_CAP,
    requestedCapability: motion ? MOTION_CAP : IMAGE_CAP,
    qualityProfile: "balanced",
    role: motion ? "imageToVideo" : stageId === "keyframe" ? "conceptImage" : "sourceGuidedImage",
    prompt: motion ? "motion brief" : "still brief",
    status,
    startedAt: new Date().toISOString(),
    ...extra
  } as ProductionJob;
}

function seedDb(jobs: ProductionJob[], tag: string): Database {
  const db = emptyDb();
  const cmpId = `cmp_${tag}`;
  const runId = `run_${tag}`;
  db.sourceMedia.push({
    id: "m1",
    creatorId: "c1",
    title: "approved creator media",
    type: "image",
    url: SOURCE,
    hash: "hash"
  });
  // Rights evidence for production authorization revalidation (Tier-3
  // workspace rows; live DKG is unsupported in this harness).
  db.passports.push({
    id: "p1",
    creatorId: "c1",
    creatorName: "Creator",
    sourceMediaIds: ["m1"],
    platforms: ["instagram"],
    countries: ["GR"],
    allowedTransformations: ["edit", "animate"],
    validFrom: "2026-01-01",
    validUntil: "2027-01-01",
    status: "active",
    attestation: { method: "creator-consent-link", consentedAt: "2026-01-01", declaration: "ok" },
    visibility: "public"
  });
  const campaign = {
    id: cmpId,
    title: "recovery pack",
    brand: "brand",
    productName: "product",
    request: {
      platform: "instagram",
      country: "GR",
      requestedClaims: [],
      transformation: "video",
      creativeBrief: "A sufficiently long creative brief for the recovery probe.",
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
    jobs: jobs.map((j) => ({ ...j, campaignId: cmpId })),
    receipts: [],
    runs: [
      {
        id: runId,
        campaignId: cmpId,
        stageIds: ["keyframe", "square", "header", "motion"],
        status: "active",
        maxConcurrency: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ],
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

/* Mocked provider: per-call mjob ids, mapped completions, mode switch. */
let seen: { tool: string; args: Record<string, unknown> }[];
let realFetch: typeof fetch | undefined;
let subscribeMode: "completed" | "running" = "completed";
let failCreateOnce: string | null = null;
const OUTPUTS = ["", KEYFRAME_OUT, SQUARE_OUT, HEADER_OUT, MOTION_OUT];

function stubProvider(): void {
  realFetch = globalThis.fetch;
  seen = [];
  let counter = 0;
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
      return send(
        ok({
          total: 2,
          capabilities: [
            { name: IMAGE_CAP, kind: "ai", availability: "available", model_id: "", description: "" },
            { name: MOTION_CAP, kind: "ai", availability: "available", model_id: "", description: "" }
          ]
        })
      );
    }
    if (tool === "get_pricing") return send(ok({ capabilities: [] }));
    seen.push({ tool, args });
    if (tool === "create_media") {
      if (typeof args.prompt === "string" && args.prompt.includes("INLINE")) {
        return send(ok({ url: INLINE_OUT, status: "completed", capability: IMAGE_CAP, cost_paid_usd: 0.003 }));
      }
      if (failCreateOnce) {
        const message = failCreateOnce;
        failCreateOnce = null;
        return send({
          result: {
            content: [{ type: "text", text: message }],
            isError: true,
            structuredContent: { error: { message } }
          },
          jsonrpc: "2.0",
          id: "t"
        });
      }
      counter += 1;
      return send(ok({ job_id: `mjob_it_${counter}`, status: "queued" }));
    }
    if (tool === "get_create_media" || tool === "subscribe_progress") {
      const id = String(args.job_id ?? args.jobId ?? "");
      const n = Number(id.split("_").at(-1));
      const url = OUTPUTS[n] || MOTION_OUT;
      if (tool === "subscribe_progress" && subscribeMode === "running") {
        return send(ok({ job_id: id, status: "running" }));
      }
      return send(ok({ job_id: id, status: "completed", url, cost_paid_usd: 0.05 }));
    }
    return send(ok({}));
  }) as typeof fetch;
}

function createCalls(): Record<string, unknown>[] {
  return seen.filter((s) => s.tool === "create_media").map((s) => s.args);
}

function subscribeHolds(): number[] {
  return seen.filter((s) => s.tool === "subscribe_progress").map((s) => Number(s.args.budget_seconds));
}

const savedEnv: Record<string, string | undefined> = {};

describe("recovery: pumpRun integration", () => {
  before(() => {
    for (const k of ["DKG_MODE", "LIVEPEER_QUALITY_CHECK", "LIVEPEER_PLACE_SUBJECT"]) {
      savedEnv[k] = process.env[k];
    }
    // DKG publish must throw (caught → failed receipt state) instead of
    // touching the local file adapter; quality/place paths stay off so the
    // DAG + async submit behavior is what varies.
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
    subscribeMode = "completed";
  });

  function useStore(jobs: ProductionJob[], tag: string) {
    seen = [];
    failCreateOnce = null;
    const { store, read } = memoryStore(seedDb(jobs, tag));
    setRunStore(store);
    return { read, ws: "ws1", cmp: `cmp_${tag}`, run: `run_${tag}` };
  }

  function campaignOf(read: () => Database, cmp: string): Campaign {
    return read().campaigns.find((c) => c.id === cmp)!;
  }

  it("runs the full pack: source to stills, keyframe to motion, provenance persisted", async () => {
    const { read, ws, cmp, run } = useStore(["keyframe", "square", "header", "motion"].map((s) => mkJob(s, "queued")), "t1");
    const pumped = await pumpRun(ws, cmp, { runId: run, budgetMs: 30000 });
    assert.equal(pumped.pumped, true);
    const campaign = campaignOf(read, cmp);
    const byStage = (id: string) => campaign.jobs.find((j) => j.stageId === id)!;

    // Every still derived from the approved source - never a sibling.
    for (const id of ["keyframe", "square", "header"]) {
      const j = byStage(id);
      assert.equal(j.requestMeta?.inputSource, "approved-source", `${id} declared source`);
      assert.equal(j.requestMeta?.resolvedInputSource, "approved-source");
      assert.equal(j.requestMeta?.sourceStageId, undefined);
      assert.equal(j.qualityProfile, "balanced");
      assert.ok(j.role);
      assert.equal(j.requestedCapability, j.capability);
      assert.ok(j.livepeerJobId?.startsWith("mjob_it_"), `${id} holds a provider id`);
    }
    // Motion used only the keyframe output.
    const motion = byStage("motion");
    assert.equal(motion.requestMeta?.sourceStageId, "keyframe");
    assert.equal(motion.requestMeta?.resolvedInputSource, "stage-output");
    const calls = createCalls();
    const motionCall = calls.find((a) => String(a.prompt).includes("motion"));
    assert.equal(motionCall?.source_url, KEYFRAME_OUT);
    for (const call of calls.filter((a) => !String(a.prompt).includes("motion"))) {
      assert.equal(call.source_url, SOURCE);
    }
    // Terminal outputs entered the preview flow with receipt inputs intact.
    assert.ok(campaign.receipts.length >= 3, "receipts published for completed stills");
    for (const r of campaign.receipts) {
      assert.ok(r.promptHash && r.promptHash.length === 64);
      assert.ok(r.qualityProfile === "balanced" && r.requestedCapability);
    }
    // Idempotency keys are stable per job across the run.
    const keys = calls.map((a) => String(a.idempotency_key));
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(keys.every((k) => k.startsWith(`pf_${cmp}_`)));
  });

  it("resumes motion after restart from a preview_ready keyframe URL", async () => {
    const { read, ws, cmp, run } = useStore([
      mkJob("keyframe", "preview_ready", { providerOutputUrl: KEYFRAME_OUT, outputUrl: KEYFRAME_OUT, livepeerJobId: "mjob_it_9", costUsd: 0.026 }),
      mkJob("motion", "queued")
    ], "t2");
    // Restart-like: only motion is in this run's scope.
    const db = read();
    db.campaigns[0].runs![0].stageIds = ["motion"];
    const pumped = await pumpRun(ws, cmp, { runId: run, budgetMs: 20000 });
    assert.equal(pumped.pumped, true);
    const motion = campaignOf(read, cmp).jobs.find((j) => j.stageId === "motion")!;
    assert.equal(motion.requestMeta?.sourceStageId, "keyframe");
    const calls = createCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].source_url, KEYFRAME_OUT, "motion resumes on that exact keyframe output");
  });

  it("inline completion finalizes without redispatch", async () => {
    const { read, ws, cmp, run } = useStore([mkJob("keyframe", "queued", { prompt: "INLINE still brief" })], "t3");
    const db = read();
    db.campaigns[0].runs![0].stageIds = ["keyframe"];
    await pumpRun(ws, cmp, { runId: run, budgetMs: 15000 });
    const keyframe = campaignOf(read, cmp).jobs.find((j) => j.stageId === "keyframe")!;
    // Preview flow ran detached to delivery (legacy path publishes the
    // receipt even when the ledger is down - kept locally as failed).
    assert.ok(keyframe.status === "preview_ready" || keyframe.status === "ready_to_share");
    assert.equal(keyframe.outputUrl, INLINE_OUT);
    assert.equal(keyframe.livepeerJobId, undefined, "no provider id invented");
    const before = createCalls().length;
    assert.equal(before, 1);
    await pumpRun(ws, cmp, { runId: run, budgetMs: 10000 });
    assert.equal(createCalls().length, before, "no duplicate submission after inline completion");
  });

  it("a failed still blocks only its dependent, never its siblings", async () => {
    const { read, ws, cmp, run } = useStore([
      mkJob("keyframe", "failed", { error: "provider blew up", finishedAt: new Date().toISOString() }),
      mkJob("square", "queued"),
      mkJob("header", "queued"),
      mkJob("motion", "queued")
    ], "t4");
    await pumpRun(ws, cmp, { runId: run, budgetMs: 20000 });
    const campaign = campaignOf(read, cmp);
    const square = campaign.jobs.find((j) => j.stageId === "square")!;
    const header = campaign.jobs.find((j) => j.stageId === "header")!;
    const motion = campaign.jobs.find((j) => j.stageId === "motion")!;
    assert.ok(square.livepeerJobId, "square dispatched despite the failed sibling");
    assert.ok(header.livepeerJobId, "header dispatched despite the failed sibling");
    assert.equal(square.requestMeta?.inputSource, "approved-source");
    assert.equal(motion.status, "failed");
    assert.match(motion.error ?? "", /keyframe/i);
    assert.ok(!motion.livepeerJobId, "motion never dispatched without its keyframe");
  });

  it("status mode never calls create_media; detached mode does", async () => {
    const { ws, cmp, run } = useStore([mkJob("keyframe", "queued"), mkJob("square", "queued")], "t5");
    const before = createCalls().length;
    const status = await pumpRun(ws, cmp, { runId: run, ...STATUS_PUMP });
    assert.equal(createCalls().length, before, "status pump dispatches nothing");
    assert.equal(status.pumped, false);
    const full = await pumpRun(ws, cmp, { runId: run, budgetMs: 15000 });
    assert.equal(full.pumped, true);
    assert.ok(createCalls().length > before, "detached-capable pump dispatches");
  });

  it("route snapshot: no provider probe or dispatch; cold pricing never blocks", async () => {
    subscribeMode = "running";
    const { getRunStatusSnapshot } = await import("./runner");
    // In-flight keyframe + terminal square: the snapshot is a database read;
    // its detached worker may advance the tracked provider job, but the HTTP
    // response itself never waits on or probes Livepeer.
    // Unpriced capabilities prove the cold-pricing path (no static fallback).
    const { read, ws, cmp, run } = useStore([
      mkJob("keyframe", "generating", { livepeerJobId: "mjob_it_50", capability: "test-unpriced-cap", requestedCapability: "test-unpriced-cap" }),
      mkJob("square", "failed", { error: "old failure", finishedAt: new Date().toISOString(), capability: "test-unpriced-cap", requestedCapability: "test-unpriced-cap" })
    ], "t6");
    const db = read();
    db.campaigns[0].runs![0].stageIds = ["keyframe", "square"];
    // Ledger prices from plan capabilities: make them unpriced so the cold
    // live-pricing path (null estimates, no wait, no failure) is exercised.
    for (const s of db.campaigns[0].preflight!.plan) s.capability = "test-unpriced-cap";
    const started = Date.now();
    const snapshot = await getRunStatusSnapshot(ws, cmp, run);
    const elapsed = Date.now() - started;
    assert.ok(snapshot, "snapshot returned");
    assert.equal(createCalls().length, 0, "status mode performs zero create_media calls");
    const holds = subscribeHolds();
    // The detached worker may already have begun its normal long provider
    // wait, but the response itself never performs the old short status
    // probe. That is what keeps browser polling cheap.
    assert.ok(holds.every((hold) => hold > 4), "no short provider probe belongs to the status response");
    assert.ok(elapsed < 1000, `snapshot stays a fast database read (took ${elapsed}ms)`);
    assert.equal(snapshot!.estimateTotal, null, "cold pricing yields null estimates, not a failure");
    assert.deepEqual(snapshot!.progress, { ready: 0, total: 2 });
    subscribeMode = "completed";
  });

  it("replacement keeps requested and actual capabilities separate, never arrow text", async () => {
    const { read, ws, cmp, run } = useStore([mkJob("square", "queued")], "t7");
    const db = read();
    db.campaigns[0].runs![0].stageIds = ["square"];
    failCreateOnce = "Livepeer Grosvenor retired: recommended replacement is test-replacement-i2v";
    await pumpRun(ws, cmp, { runId: run, budgetMs: 20000 });
    const job = campaignOf(read, cmp).jobs.find((j) => j.stageId === "square")!;
    assert.equal(job.requestedCapability, IMAGE_CAP);
    assert.equal(job.actualCapability, "test-replacement-i2v");
    assert.equal(job.capability, IMAGE_CAP, "planned value untouched by display text");
    assert.ok(!job.capability.includes("→") && !(job.actualCapability ?? "").includes("→"));
    // The retry went out on the replacement model under the same run.
    const calls = createCalls();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].model_override, "test-replacement-i2v");
    assert.equal(calls[0].idempotency_key, calls[1].idempotency_key, "same stage key across the recovery retry");
  });

  it("ledger prices the actual replacement model at the resolved duration", async () => {
    const { runSpendLedger } = await import("./runner");
    const { read, ws, cmp, run } = useStore([
      mkJob("square", "ready_to_share", {
        outputUrl: SQUARE_OUT,
        providerOutputUrl: SQUARE_OUT,
        capability: "flux-dev",
        requestedCapability: "flux-dev",
        actualCapability: "flux-pro",
        costUsd: 0.063
      })
    ], "t8");
    const db = read();
    db.campaigns[0].runs![0].stageIds = ["square"];
    const ledger = await runSpendLedger(ws, cmp, run, new Map());
    assert.ok(ledger, "ledger returned");
    // flux-pro $0.063/image - not the planned flux-dev $0.026.
    assert.equal(ledger!.estimateTotal, 0.063);
    assert.equal(ledger!.stages[0].pricedCapability, "flux-pro");
    assert.equal(ledger!.actualTotal, 0.063, "actual provider cost preferred");
  });

  it("receipts carry full duration provenance and the actual capability", async () => {
    const { read, ws, cmp, run } = useStore([
      mkJob("keyframe", "ready_to_share", { providerOutputUrl: KEYFRAME_OUT, outputUrl: KEYFRAME_OUT }),
      mkJob("motion", "queued")
    ], "t9");
    await pumpRun(ws, cmp, { runId: run, budgetMs: 25000 });
    const campaign = campaignOf(read, cmp);
    const receipt = campaign.receipts.find((r) => r.jobId === "job_motion");
    assert.ok(receipt, "motion receipt published");
    assert.equal(receipt!.durationSeconds, 5);
    assert.equal(receipt!.requestedDurationSeconds, 5);
    assert.equal(receipt!.durationSource, "product-range-unverified");
    assert.equal(receipt!.durationNote, undefined);
    assert.equal(receipt!.requestedCapability, MOTION_CAP);
    assert.ok(receipt!.actualCapability, "actual model recorded");
    assert.ok(!(receipt!.actualCapability ?? "").includes("→"), "no display text in provenance");
    assert.ok(!(receipt!.capability ?? "").includes("→"), "no display text in capability");
  });

  it("legacy rows without provenance fields still finalize and publish", async () => {
    const { read, ws, cmp, run } = useStore([
      {
        id: "job_legacy",
        campaignId: "cmp_t10",
        stageId: "square",
        kind: "text-to-image",
        capability: "flux-dev",
        prompt: "legacy brief",
        status: "queued",
        startedAt: new Date().toISOString()
      } as unknown as ProductionJob
    ], "t10");
    const db = read();
    db.campaigns[0].runs![0].stageIds = ["square"];
    await pumpRun(ws, cmp, { runId: run, budgetMs: 20000 });
    const campaign = campaignOf(read, cmp);
    const job = campaign.jobs.find((j) => j.id === "job_legacy")!;
    assert.ok(job.outputUrl, "legacy job delivered");
    assert.equal(job.actualCapability, "flux-dev", "actual defaults to the dispatched model");
    assert.equal(job.requestedCapability, "flux-dev", "requested backfilled from the plan stage");
    const receipt = campaign.receipts.find((r) => r.jobId === "job_legacy");
    assert.ok(receipt, "legacy receipt published");
    assert.equal(receipt!.durationSeconds, undefined, "still rows carry no duration");
  });
});
