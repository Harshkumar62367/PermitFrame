import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ProductionJob, ProductionRun } from "../types";
import {
  findActiveRun,
  nextJobAction,
  selectDispatchable,
  shouldDispatchUnderCap,
  splitCancelTargets,
  resolveMaxConcurrency,
  placeSubjectMode,
  qualityCheckEnabled,
  resolveProgressHold,
  STATUS_PUMP,
  pollProviderJob,
  classifySubmitResult,
  computeBackoffMs,
  classifySubmitError,
  isBackoffPending,
  redactSubmitError,
  maxDispatchAttempts,
  provenanceMeta,
  finalizedPreviewFields
} from "./runner";
import { decideStageRuns, normalizeStagePlan, validatePlan } from "./plan-dag";
import { withLock } from "./mutex";
import { LivepeerMcpClient, livepeerConfig } from "./mcp-client";

/**
 * Async runner tests. Dispatch math is pure (no I/O); Livepeer traffic is
 * mocked fetch - no inference, no spend. DB-backed pump paths are covered
 * by construction (decisions + slots + gates below).
 */

function job(partial: Partial<ProductionJob> & { id: string; stageId: string; status: ProductionJob["status"] }): ProductionJob {
  return {
    campaignId: "cmp_x",
    kind: "text-to-image",
    capability: "flux-dev",
    prompt: "p",
    startedAt: new Date().toISOString(),
    ...partial
  } as ProductionJob;
}

function stages() {
  return validatePlan(
    normalizeStagePlan(
      [
        { id: "keyframe", kind: "text-to-image", capability: "flux-dev", label: "Keyframe", format: "9:16" },
        { id: "square", kind: "image-to-image", capability: "flux-dev", label: "Square", format: "1:1" },
        { id: "motion", kind: "image-to-video", capability: "kling-v3-turbo-i2v", label: "Motion", format: "9:16" }
      ],
      "balanced"
    )
  );
}

describe("dispatch selection", () => {
  it("fills the ceiling in dependency order and no further", () => {
    const jobs = [job({ id: "j1", stageId: "keyframe", status: "queued" }), job({ id: "j2", stageId: "square", status: "queued" }), job({ id: "j3", stageId: "motion", status: "queued" })];
    const decisions = decideStageRuns(stages(), jobs, "https://source.example/s.png");
    // keyframe + square runnable; motion waits for its keyframe.
    const slots = selectDispatchable(decisions, jobs, 1, 3);
    assert.equal(slots.length, 2);
    assert.deepEqual(slots.map((s) => s.job.id), ["j1", "j2"]);
    assert.ok(slots.every((s) => s.inputUrl === "https://source.example/s.png"));
  });

  it("zero slots when the ceiling is already filled", () => {
    const jobs = [job({ id: "j1", stageId: "keyframe", status: "queued" })];
    const decisions = decideStageRuns(stages(), jobs, "https://source.example/s.png");
    assert.equal(selectDispatchable(decisions, jobs, 3, 3).length, 0);
    assert.equal(selectDispatchable(decisions, jobs, 5, 3).length, 0);
  });

  it("partial failure dispatches survivors, never the dependent", () => {
    const jobs = [
      job({ id: "j1", stageId: "keyframe", status: "failed" }),
      job({ id: "j2", stageId: "square", status: "queued" }),
      job({ id: "j3", stageId: "motion", status: "queued" })
    ];
    const decisions = decideStageRuns(stages(), jobs, "https://source.example/s.png");
    const slots = selectDispatchable(decisions, jobs, 0, 3);
    assert.deepEqual(slots.map((s) => s.job.id), ["j2"]);
  });

  it("a completed keyframe unlocks motion with that exact output", () => {
    const jobs = [
      job({ id: "j1", stageId: "keyframe", status: "preview_ready", providerOutputUrl: "https://cdn.example/k.png", outputUrl: "https://cdn.example/k.png" } as never),
      job({ id: "j3", stageId: "motion", status: "queued" })
    ];
    const decisions = decideStageRuns(stages(), jobs, "https://source.example/s.png");
    const slots = selectDispatchable(decisions, jobs, 0, 3);
    assert.equal(slots.length, 1);
    assert.equal(slots[0].inputUrl, "https://cdn.example/k.png");
    assert.equal(slots[0].sourceStageId, "keyframe");
  });
});

describe("resume actions", () => {
  it("polls in-flight jobs with provider ids, submits the rest, ignores settled", () => {
    assert.equal(nextJobAction(job({ id: "a", stageId: "s", status: "generating", livepeerJobId: "mjob_1" })), "poll");
    assert.equal(nextJobAction(job({ id: "b", stageId: "s", status: "queued" })), "submit");
    assert.equal(nextJobAction(job({ id: "c", stageId: "s", status: "generating" })), "submit");
    assert.equal(nextJobAction(job({ id: "d", stageId: "s", status: "ready_to_share" })), "ignore");
    assert.equal(nextJobAction(job({ id: "e", stageId: "s", status: "failed" })), "ignore");
    assert.equal(nextJobAction(job({ id: "f", stageId: "s", status: "preview_ready" })), "ignore");
  });
});

describe("spend ceiling", () => {
  it("refuses only when a known estimate breaches the cap", () => {
    assert.equal(shouldDispatchUnderCap(0.5, 0.2, 1).ok, true);
    const refused = shouldDispatchUnderCap(0.9, 0.2, 1);
    assert.equal(refused.ok, false);
    assert.match(refused.reason ?? "", /\$1\.00 cap/);
    assert.equal(shouldDispatchUnderCap(99, null, 1).ok, true);
    assert.equal(shouldDispatchUnderCap(99, 99, undefined).ok, true);
  });
});

describe("run idempotency", () => {
  const runs: ProductionRun[] = [
    { id: "run_1", campaignId: "cmp_x", stageIds: ["a", "b"], status: "active", idempotencyKey: "key-1", maxConcurrency: 3, createdAt: "", updatedAt: "" },
    { id: "run_0", campaignId: "cmp_x", stageIds: ["a"], status: "complete", maxConcurrency: 3, createdAt: "", updatedAt: "" }
  ];
  it("repeats return the existing active run", () => {
    assert.equal(findActiveRun(runs, "key-1", ["a", "b"])?.id, "run_1");
    assert.equal(findActiveRun(runs, "other", ["a", "b"])?.id, "run_1");
    assert.equal(findActiveRun(runs, undefined, ["a"])?.id, undefined);
    assert.equal(findActiveRun([], "key-1", ["a", "b"]), undefined);
  });
});

describe("cancel split", () => {
  it("local-cancel undispatched, provider-attempt in-flight, skip the rest", () => {
    const jobs = [
      job({ id: "q", stageId: "s", status: "queued" }),
      job({ id: "g", stageId: "s", status: "generating", livepeerJobId: "mjob_9" }),
      job({ id: "r", stageId: "s", status: "ready_to_share" }),
      job({ id: "f", stageId: "s", status: "failed" })
    ];
    const split = splitCancelTargets(jobs);
    assert.deepEqual(split.local.map((j) => j.id), ["q"]);
    assert.deepEqual(split.provider.map((j) => j.id), ["g"]);
    assert.deepEqual(split.skipped.map((s) => s.job.id).sort(), ["f", "r"]);
  });
});

describe("concurrency + env gates", () => {
  const savedMax = process.env.LIVEPEER_MAX_CONCURRENCY;
  const savedPlace = process.env.LIVEPEER_PLACE_SUBJECT;
  const savedQc = process.env.LIVEPEER_QUALITY_CHECK;
  afterEach(() => {
    if (savedMax === undefined) delete process.env.LIVEPEER_MAX_CONCURRENCY;
    else process.env.LIVEPEER_MAX_CONCURRENCY = savedMax;
    if (savedPlace === undefined) delete process.env.LIVEPEER_PLACE_SUBJECT;
    else process.env.LIVEPEER_PLACE_SUBJECT = savedPlace;
    if (savedQc === undefined) delete process.env.LIVEPEER_QUALITY_CHECK;
    else process.env.LIVEPEER_QUALITY_CHECK = savedQc;
  });

  it("defaults to 3, honors env, caps at the tier", () => {
    delete process.env.LIVEPEER_MAX_CONCURRENCY;
    assert.equal(resolveMaxConcurrency(), 3);
    process.env.LIVEPEER_MAX_CONCURRENCY = "2";
    assert.equal(resolveMaxConcurrency(), 2);
    process.env.LIVEPEER_MAX_CONCURRENCY = "99";
    assert.ok(resolveMaxConcurrency() <= 4);
  });

  it("place_subject defaults to auto, quality check defaults on", () => {
    delete process.env.LIVEPEER_PLACE_SUBJECT;
    delete process.env.LIVEPEER_QUALITY_CHECK;
    assert.equal(placeSubjectMode(), "auto");
    assert.equal(qualityCheckEnabled(), true);
    process.env.LIVEPEER_PLACE_SUBJECT = "off";
    process.env.LIVEPEER_QUALITY_CHECK = "off";
    assert.equal(placeSubjectMode(), "off");
    assert.equal(qualityCheckEnabled(), false);
  });
});

describe("campaign lock", () => {
  it("serializes concurrent writes in acquisition order", async () => {
    const order: string[] = [];
    await Promise.all([
      withLock("test-key", async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 20));
        order.push("a-end");
      }),
      withLock("test-key", async () => {
        order.push("b-start");
        order.push("b-end");
      })
    ]);
    assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
  });
});

describe("progress-hold budgets", () => {
  it("status-pump constants fit inside the 15s UI request timeout", () => {
    assert.ok(STATUS_PUMP.budgetMs <= 8000, "status GET targets <= 8s");
    assert.ok(STATUS_PUMP.progressHoldSeconds <= 8, "short progress hold");
    assert.ok(STATUS_PUMP.budgetMs + STATUS_PUMP.progressHoldSeconds * 1000 < 15000, "compatible with the UI budget");
    assert.equal(STATUS_PUMP.allowDispatch, false, "status mode never dispatches");
    assert.equal(STATUS_PUMP.allowPreviewResume, false, "status mode never blocks on resume");
  });

  it("holds clamp to the provider 1-25s window with a 20s detached default", () => {
    assert.equal(resolveProgressHold(undefined), 20);
    assert.equal(resolveProgressHold(4), 4);
    assert.equal(resolveProgressHold(0), 1);
    assert.equal(resolveProgressHold(99), 25);
    assert.equal(resolveProgressHold(Number.NaN), 20);
  });
});

describe("submit classification", () => {
  it("finalizes inline usable outputs without inventing a job id", () => {
    const r = classifySubmitResult({ outputUrl: "https://cdn.example/inline.png", costUsd: 0.02, capability: "flux-dev" });
    assert.equal(r.action, "finalize");
    if (r.action === "finalize") {
      assert.equal(r.providerUrl, "https://cdn.example/inline.png");
      assert.equal(r.costUsd, 0.02);
    }
  });

  it("tracks non-empty provider ids and fails honestly otherwise", () => {
    assert.deepEqual(classifySubmitResult({ jobId: "mjob_7" }), { action: "track", jobId: "mjob_7" });
    const empty = classifySubmitResult({ jobId: "  " });
    assert.equal(empty.action, "fail");
    const neither = classifySubmitResult({});
    assert.equal(neither.action, "fail");
    if (neither.action === "fail") assert.match(neither.reason, /neither.*usable output.*provider job id/);
    const badUrl = classifySubmitResult({ outputUrl: "http://cdn.example/plain.png", jobId: "" });
    assert.equal(badUrl.action, "fail");
  });

  it("finalized jobs are never re-submitted", () => {
    const finalized = job({ id: "x", stageId: "s", status: "preview_ready", providerOutputUrl: "https://cdn.example/k.png", outputUrl: "https://cdn.example/k.png" });
    assert.equal(nextJobAction(finalized), "ignore");
  });
});

describe("retry backoff", () => {
  it("backs off exponentially with a 15-minute cap", () => {
    assert.equal(computeBackoffMs(0), 0);
    assert.equal(computeBackoffMs(1), 30_000);
    assert.equal(computeBackoffMs(2), 60_000);
    assert.equal(computeBackoffMs(3), 120_000);
    assert.equal(computeBackoffMs(10), 900_000);
    assert.equal(computeBackoffMs(100), 900_000);
  });

  it("classifies terminal rejections vs transient transport failures", () => {
    assert.equal(classifySubmitError("Capability X is not currently available"), "terminal");
    assert.equal(classifySubmitError("quote $1.20 exceeds max_cost_usd $0.25"), "terminal");
    assert.equal(classifySubmitError("unauthorized: bad credentials"), "terminal");
    assert.equal(classifySubmitResult({ jobId: "mjob_1" }).action, "track");
    assert.equal(classifySubmitError("network timeout"), "transient");
    assert.equal(classifySubmitError("Livepeer MCP request failed (503)"), "transient");
    assert.equal(classifySubmitError("socket hang up"), "transient");
  });

  it("redacts credential-shaped material from persisted errors", () => {
    const redacted = redactSubmitError("failed: Bearer secret-bearer-xyz-123 rejected with api_key = abcdef and a very long tail " + "x".repeat(300));
    assert.ok(!redacted.includes("secret-bearer-xyz-123"));
    assert.ok(!redacted.includes("abcdef"));
    assert.ok(redacted.length <= 200);
  });

  it("skips backoff-pending jobs until their window passes", () => {
    const now = Date.now();
    const waiting = job({ id: "w", stageId: "keyframe", status: "generating", nextAttemptAt: new Date(now + 60_000).toISOString() });
    const due = job({ id: "d", stageId: "keyframe", status: "generating", nextAttemptAt: new Date(now - 1000).toISOString() });
    assert.equal(isBackoffPending(waiting, now), true);
    assert.equal(isBackoffPending(due, now), false);
    assert.equal(isBackoffPending(job({ id: "q", stageId: "s", status: "queued" }), now), false);
    assert.equal(isBackoffPending(job({ id: "f", stageId: "s", status: "failed", nextAttemptAt: new Date(now + 60_000).toISOString() }), now), false);
    const jobs = [waiting];
    const decisions = decideStageRuns(stages(), jobs, "https://source.example/s.png");
    assert.equal(selectDispatchable(decisions, jobs, 0, 3, now).length, 0);
    assert.equal(selectDispatchable(decisions, [due], 0, 3, now).length, 1);
  });

  it("exhausts attempts at the configured maximum", () => {
    const saved = process.env.LIVEPEER_MAX_ATTEMPTS;
    try {
      delete process.env.LIVEPEER_MAX_ATTEMPTS;
      assert.equal(maxDispatchAttempts(), 5);
      process.env.LIVEPEER_MAX_ATTEMPTS = "2";
      assert.equal(maxDispatchAttempts(), 2);
    } finally {
      if (saved === undefined) delete process.env.LIVEPEER_MAX_ATTEMPTS;
      else process.env.LIVEPEER_MAX_ATTEMPTS = saved;
    }
  });
});

describe("provenance mapping", () => {
  it("records profile, role, requested capability, and resolved input", () => {
    const [stage] = normalizeStagePlan(
      [{ id: "motion", kind: "image-to-video", capability: "kling-v3-turbo-i2v", label: "Motion", format: "9:16" }],
      "premium"
    );
    const withDep = { ...stage, dependsOnStageIds: ["keyframe"] };
    const meta = provenanceMeta(withDep, { resolvedInputSource: "stage-output", sourceStageId: "keyframe" });
    assert.equal(meta.sourceKind, "prior-output");
    assert.equal(meta.inputSource, "stage-output");
    assert.equal(meta.resolvedInputSource, "stage-output");
    assert.equal(meta.sourceStageId, "keyframe");
    assert.equal(meta.qualityProfile, "premium");
    assert.equal(meta.role, "imageToVideo");
    const meta2 = provenanceMeta(stage, { resolvedInputSource: "approved-source" });
    assert.equal(meta2.sourceKind, "source-media");
    assert.equal(meta2.sourceStageId, undefined);
  });

  it("finalize patch carries everything the receipt needs, never display text", () => {
    const patch = finalizedPreviewFields({
      providerUrl: "https://cdn.example/out.png",
      livepeerJobId: "mjob_5",
      costUsd: 0.11,
      modelNote: "n"
    });
    assert.equal(patch.status, "preview_ready");
    assert.equal(patch.providerOutputUrl, "https://cdn.example/out.png");
    assert.equal(patch.outputUrl, "https://cdn.example/out.png");
    assert.ok(typeof patch.providerUrlFingerprint === "string" && patch.providerUrlFingerprint.length === 64);
    assert.equal(patch.costUsd, 0.11);
    assert.equal((patch as Record<string, unknown>).capability, undefined, "planned capability is never overwritten with display text");
  });

  it("display labels derive from structured fields, legacy arrows render as-is", async () => {
    const { displayCapability } = await import("@/components/studio/studio-model");
    assert.equal(
      displayCapability({ capability: "flux-dev", requestedCapability: "flux-dev", actualCapability: "flux-pro" }),
      "flux-dev → flux-pro"
    );
    assert.equal(displayCapability({ capability: "flux-dev", actualCapability: "flux-dev" }), "flux-dev");
    assert.equal(displayCapability({ capability: "flux-dev" }), "flux-dev");
    assert.equal(
      displayCapability({ capability: "flux-dev → flux-pro (auto-recovered)" }),
      "flux-dev → flux-pro (auto-recovered)"
    );
  });
});

/* ------------------------- mocked provider surface ------------------------ */

function envelope(payload: Record<string, unknown>): Record<string, unknown> {
  return { result: payload, jsonrpc: "2.0", id: "test-id" };
}

function okTool(structured: Record<string, unknown>, text = ""): Record<string, unknown> {
  return envelope({ structuredContent: structured, content: text ? [{ type: "text", text }] : [] });
}

const INIT = envelope({ protocolVersion: "2025-03-26", serverInfo: { name: "mock" } });

let seenArgs: Record<string, unknown>[];
let realFetch: typeof fetch | undefined;
let failNext: string | null = null;

function stubFetch(): void {
  realFetch = globalThis.fetch;
  seenArgs = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (body.method === "initialize") {
      return new Response(JSON.stringify(INIT), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (body.method === "notifications/initialized") {
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }
    const tool = String(body.params?.name);
    const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
    seenArgs.push({ tool, ...args });
    if (failNext === tool) {
      failNext = null;
      throw new Error("network timeout (mock)");
    }
    switch (tool) {
      case "create_media":
        if (args.async === true && args.prompt === "inline-test") {
          return new Response(JSON.stringify(okTool({ url: "https://cdn.example/inline.png", status: "completed", capability: "flux-schnell", cost_paid_usd: 0.003 })), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (args.async === true) return new Response(JSON.stringify(okTool({ job_id: "mjob_42", status: "queued" })), { status: 200, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify(okTool({ url: "https://cdn.example/sync.png", status: "completed", capability: "flux-dev", cost_paid_usd: 0.026 })), { status: 200, headers: { "content-type": "application/json" } });
      case "get_create_media":
        return new Response(JSON.stringify(okTool({ job_id: "mjob_42", status: "completed", url: "https://cdn.example/async.png", cost_paid_usd: 0.31 })), { status: 200, headers: { "content-type": "application/json" } });
      case "subscribe_progress":
        return new Response(JSON.stringify(okTool({ job_id: "mjob_42", status: "running" })), { status: 200, headers: { "content-type": "application/json" } });
      case "place_subject":
        return new Response(JSON.stringify(okTool({ url: "https://cdn.example/placed.png", status: "completed" })), { status: 200, headers: { "content-type": "application/json" } });
      case "create_variations":
        return new Response(JSON.stringify(okTool({ url: "https://cdn.example/varied.png", status: "completed" })), { status: 200, headers: { "content-type": "application/json" } });
      case "cancel_job":
        return new Response(JSON.stringify(okTool({ status: "cancelled" }, "job cancelled")), { status: 200, headers: { "content-type": "application/json" } });
      case "critique_shot":
        return new Response(JSON.stringify(okTool({ weighted_total: 0.86, pass_fail: "pass" })), { status: 200, headers: { "content-type": "application/json" } });
      default:
        return new Response(JSON.stringify(okTool({})), { status: 200, headers: { "content-type": "application/json" } });
    }
  }) as typeof fetch;
}

describe("async provider operations (mocked)", () => {
  afterEach(() => {
    if (realFetch) globalThis.fetch = realFetch;
    realFetch = undefined;
    failNext = null;
  });

  it("async submit returns the provider id without holding for output", async () => {
    stubFetch();
    const client = new LivepeerMcpClient(livepeerConfig());
    const r = await client.submitMedia({ capability: "flux-dev", kind: "text-to-image", prompt: "p", idempotencyKey: "pf_x" });
    assert.equal(r.jobId, "mjob_42");
    const call = seenArgs.find((a) => a.tool === "create_media");
    assert.equal(call?.async, true);
    assert.equal(call?.idempotency_key, "pf_x");
  });

  it("status poll parses terminal completion with cost", async () => {
    stubFetch();
    const client = new LivepeerMcpClient(livepeerConfig());
    const s = await client.getMediaStatus("mjob_42");
    assert.equal(s.terminal, true);
    assert.equal(s.outputUrl, "https://cdn.example/async.png");
    assert.equal(s.costUsd, 0.31);
  });

  it("progress wait returns non-terminal snapshots for re-polling", async () => {
    stubFetch();
    const client = new LivepeerMcpClient(livepeerConfig());
    const s = await client.waitForProgress("mjob_42", 10);
    assert.equal(s.terminal, false);
    const call = seenArgs.find((a) => a.tool === "subscribe_progress");
    assert.equal(call?.job_id, "mjob_42");
  });

  it("timeout retries reuse the same idempotency key (provider dedupes)", async () => {
    stubFetch();
    const client = new LivepeerMcpClient(livepeerConfig());
    const input = { capability: "flux-dev", kind: "text-to-image" as const, prompt: "p", idempotencyKey: "pf_retry_1" };
    failNext = "create_media";
    await assert.rejects(() => client.submitMedia(input), /network timeout/);
    const retry = await client.submitMedia(input);
    assert.equal(retry.jobId, "mjob_42");
    const keys = seenArgs.filter((a) => a.tool === "create_media").map((a) => a.idempotency_key);
    assert.deepEqual(keys, ["pf_retry_1", "pf_retry_1"]);
  });

  it("place_subject, variations, cancel, and critique parse honestly", async () => {
    stubFetch();
    const client = new LivepeerMcpClient(livepeerConfig());
    const placed = await client.placeSubject({ sourceUrl: "https://s.example/p.png", scenes: ["on a podium"] });
    assert.deepEqual(placed.outputUrls, ["https://cdn.example/placed.png"]);
    const varied = await client.createVariations({ sourceUrl: "https://cdn.example/k.png", prompt: "warmer", mode: "prompt", count: 1 });
    assert.deepEqual(varied.outputUrls, ["https://cdn.example/varied.png"]);
    const cancelled = await client.cancelProviderJob("mjob_42");
    assert.equal(cancelled.cancelled, true);
    const critique = await client.critiqueShot({ generatedUrl: "https://cdn.example/k.png", referenceUrl: "https://s.example/p.png" });
    assert.equal(critique.score, 0.86);
    assert.equal(critique.passed, true);
  });

  it("inline completed submits carry the output with no job id", async () => {
    stubFetch();
    const client = new LivepeerMcpClient(livepeerConfig());
    const r = await client.submitMedia({ capability: "flux-schnell", kind: "text-to-image", prompt: "inline-test", idempotencyKey: "pf_inline" });
    assert.equal(r.jobId, undefined);
    assert.equal(r.outputUrl, "https://cdn.example/inline.png");
    assert.equal(r.costUsd, 0.003);
    assert.equal(classifySubmitResult(r).action, "finalize");
  });

  it("progress probe uses the configured short hold and falls back to status", async () => {
    stubFetch();
    const client = new LivepeerMcpClient(livepeerConfig());
    const snap = await pollProviderJob(client, "mjob_42", 4);
    assert.equal(snap.terminal, false);
    const short = seenArgs.find((a) => a.tool === "subscribe_progress");
    assert.equal(short?.job_id, "mjob_42");
    assert.equal(short?.budget_seconds, 4, "short hold passes through unclamped");
    const clamped = await pollProviderJob(client, "mjob_42", 99);
    assert.equal(clamped.terminal, false);
    const wide = seenArgs.filter((a) => a.tool === "subscribe_progress").at(-1);
    assert.equal(wide?.budget_seconds, 25, "holds clamp to the provider window");
    // subscribe_progress failure falls back to get_create_media honestly.
    failNext = "subscribe_progress";
    const fb = await pollProviderJob(client, "mjob_42", 4);
    assert.equal(fb.terminal, true);
    assert.equal(fb.outputUrl, "https://cdn.example/async.png");
  });
});
