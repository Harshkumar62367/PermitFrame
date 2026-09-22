import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Campaign, Database, ProductionJob, ProductionStagePlan } from "../types";
import { emptyDb } from "../store";
import { setRunStore, memoryStore } from "./run-store";
import { pumpRun, submitRun } from "./runner";

/**
 * Async preservation-handle safety (Prompt-4 correction).
 *
 * Previous behavior: place_subject / create_variations expected an inline
 * output URL, so a valid async job_id (no inline URL) was recorded as a
 * failure and guided create_media was submitted - potentially two paid
 * provider jobs for one PermitFrame job.
 *
 * Fixed behavior, proven end-to-end here with an in-memory workspace and
 * mocked fetch (synthetic HTTPS URLs, zero network, zero spend):
 * - inline: finalizes from the URL, one tool call, no fallback;
 * - async: the provider handle persists on the job, the job stays
 *   generating, polling delivers it, and create_media NEVER runs while
 *   the preservation job is pending (exactly one tool call total);
 * - terminal async failure: the tool is exhausted, the job re-queues, and
 *   exactly one guided create_media follows (one + one, never two + one);
 * - malformed (no URL, no handle): immediate single guided fallback.
 */

const SOURCE = "https://source.example/approved-creator.png";
const SQUARE_OUT = "https://cdn.example/square-11.png";
const VARIED_OUT = "https://cdn.example/varied-async.png";
const GUIDED_OUT = "https://cdn.example/guided-fallback.png";
const IMAGE_CAP = "flux-dev";

type VaryMode = "inline" | "async" | "async-fail" | "malformed";
let varyMode: VaryMode = "inline";

function planStages(): ProductionStagePlan[] {
  return [
    { id: "keyframe", kind: "text-to-image", capability: IMAGE_CAP, label: "Campaign keyframe (9:16)", format: "9:16", dependsOnStageIds: [], inputSource: "approved-source", qualityProfile: "balanced", role: "conceptImage" },
    { id: "square", kind: "image-to-image", capability: IMAGE_CAP, label: "Square (1:1)", format: "1:1", dependsOnStageIds: [], inputSource: "approved-source", qualityProfile: "balanced", role: "sourceGuidedImage" }
  ];
}

function seedDb(): Database {
  const db = emptyDb();
  db.sourceMedia.push({ id: "m1", creatorId: "c1", title: "approved creator media", type: "image", url: SOURCE, hash: "hash" });
  const jobs: ProductionJob[] = [
    {
      id: "job_orig",
      campaignId: "cmp_async",
      stageId: "square",
      kind: "image-to-image",
      capability: IMAGE_CAP,
      requestedCapability: IMAGE_CAP,
      qualityProfile: "balanced",
      role: "sourceGuidedImage",
      prompt: "still brief",
      status: "ready_to_share",
      providerOutputUrl: SQUARE_OUT,
      outputUrl: SQUARE_OUT,
      costUsd: 0.05,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    } as ProductionJob,
    {
      id: "job_v1",
      campaignId: "cmp_async",
      stageId: "square",
      kind: "image-to-image",
      capability: IMAGE_CAP,
      requestedCapability: IMAGE_CAP,
      qualityProfile: "balanced",
      role: "sourceGuidedImage",
      prompt: "still brief Explicit variation from the selected completed output.",
      status: "queued",
      startedAt: new Date().toISOString(),
      variationExplicit: true,
      variationSourceUrl: SQUARE_OUT
    } as ProductionJob
  ];
  const campaign = {
    id: "cmp_async",
    title: "async pack",
    brand: "brand",
    productName: "product",
    request: {
      platform: "instagram",
      country: "GR",
      requestedClaims: [],
      transformation: "video",
      creativeBrief: "A sufficiently long creative brief for the async probe.",
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
    runs: [],
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
    if (tool === "create_variations") {
      if (varyMode === "inline") return send(ok({ url: VARIED_OUT, status: "completed", cost_paid_usd: 0.04 }));
      if (varyMode === "malformed") return send(ok({ note: "accepted" }));
      return send(ok({ job_id: "mjob_vary_1", status: "queued" }));
    }
    if (tool === "create_media") {
      return send(ok({ job_id: "mjob_media_1", status: "queued" }));
    }
    if (tool === "get_create_media" || tool === "subscribe_progress") {
      const id = String(args.job_id ?? args.jobId ?? "");
      if (id === "mjob_vary_1") {
        if (varyMode === "async-fail") return send(ok({ job_id: id, status: "failed" }));
        return send(ok({ job_id: id, status: "completed", url: VARIED_OUT, cost_paid_usd: 0.04 }));
      }
      return send(ok({ job_id: id, status: "completed", url: GUIDED_OUT, cost_paid_usd: 0.05 }));
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

describe("async preservation handles", () => {
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

  function useStore(mode: VaryMode) {
    varyMode = mode;
    seen = [];
    const { store, read } = memoryStore(seedDb());
    setRunStore(store);
    return { read, ws: "ws1" };
  }

  function campaignOf(read: () => Database): Campaign {
    return read().campaigns.find((c) => c.id === "cmp_async")!;
  }

  async function runVariation(read: () => Database, ws: string): Promise<string> {
    const submitted = await submitRun({ campaignId: "cmp_async", jobIds: ["job_v1"], workspaceId: ws });
    assert.equal(submitted.created, true);
    const runId = submitted.run?.id;
    assert.ok(runId);
    await pumpRun(ws, "cmp_async", { runId, budgetMs: 30000 });
    const start = Date.now();
    for (;;) {
      const s = campaignOf(read).jobs.find((j) => j.id === "job_v1")?.status;
      if (s !== "queued" && s !== "generating") return s as string;
      if (Date.now() - start > 25000) throw new Error("variation job did not settle");
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  it("inline success finalizes with one tool call and no fallback", async () => {
    const { read, ws } = useStore("inline");
    assert.equal(await runVariation(read, ws), "ready_to_share");
    assert.equal(varyCalls().length, 1);
    assert.equal(mediaCalls().length, 0);
    const j = campaignOf(read).jobs.find((x) => x.id === "job_v1")!;
    assert.equal(j.requestMeta?.preservationActualCapability, "create_variations");
    assert.equal(j.requestMeta?.providerOperationSucceeded, true);
    assert.equal(j.costUsd, 0.04);
  });

  it("async handle tracks and polls with zero fallback while pending", async () => {
    const { read, ws } = useStore("async");
    assert.equal(await runVariation(read, ws), "ready_to_share");
    // Exactly one preservation call; the handle was polled, never replaced.
    assert.equal(varyCalls().length, 1);
    assert.equal(mediaCalls().length, 0, "no create_media while the preservation job was pending");
    const j = campaignOf(read).jobs.find((x) => x.id === "job_v1")!;
    assert.equal(j.livepeerJobId, "mjob_vary_1", "async provider handle persisted on the job");
    assert.equal(j.requestMeta?.preservationPendingTool, undefined, "pending marker cleared on delivery");
    assert.equal(j.requestMeta?.preservationActualCapability, "create_variations");
    assert.equal(j.requestMeta?.providerOperationSucceeded, true);
    assert.equal(j.outputUrl, VARIED_OUT);
    assert.equal(j.costUsd, 0.04);
  });

  it("terminal async failure falls back exactly once, then renders guided", async () => {
    const { read, ws } = useStore("async-fail");
    assert.equal(await runVariation(read, ws), "ready_to_share");
    assert.equal(varyCalls().length, 1, "rejected tool never retried - no second paid preservation job");
    assert.equal(mediaCalls().length, 1, "exactly one guided fallback");
    const j = campaignOf(read).jobs.find((x) => x.id === "job_v1")!;
    assert.deepEqual(j.requestMeta?.preservationFailedTools, ["create_variations"]);
    assert.match(j.requestMeta?.fallbackReason ?? "", /without an output/);
    assert.equal(j.requestMeta?.preservationActualCapability, "create_media");
    assert.equal(j.requestMeta?.preservationEvidenceLevel, "source-guided");
    assert.equal(j.requestMeta?.providerOperationSucceeded, true, "the guided render succeeded");
    assert.equal(j.outputUrl, GUIDED_OUT);
    // Recovery stability: another pump never re-attempts the dead tool.
    const campaign = campaignOf(read);
    const runId = campaign.runs?.find((r) => r.status === "active")?.id;
    if (runId) await pumpRun(ws, "cmp_async", { runId, budgetMs: 5000 });
    assert.equal(varyCalls().length, 1, "no second preservation call after recovery");
    assert.equal(mediaCalls().length, 1, "no duplicate guided submit after recovery");
  });

  it("malformed response with no handle falls back immediately and once", async () => {
    const { read, ws } = useStore("malformed");
    assert.equal(await runVariation(read, ws), "ready_to_share");
    assert.equal(varyCalls().length, 1);
    assert.equal(mediaCalls().length, 1, "single immediate guided fallback");
    const j = campaignOf(read).jobs.find((x) => x.id === "job_v1")!;
    assert.match(j.requestMeta?.fallbackReason ?? "", /no usable output and no provider job id/);
    assert.equal(j.requestMeta?.preservationActualCapability, "create_media");
    assert.equal(j.outputUrl, GUIDED_OUT);
  });
});
