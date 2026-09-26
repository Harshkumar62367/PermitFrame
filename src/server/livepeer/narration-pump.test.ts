import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Campaign, Database } from "../types";
import { emptyDb, sha256 } from "../store";
import { setRunStore, memoryStore, writeWorkspace } from "./run-store";
import { withCampaignLock } from "./mutex";
import { publicOutputsForShare } from "../public-share";
import type { MediaStatusResult } from "./mcp-client";
import type { FilmRun } from "./film-run";
import type { FilmNarrationJob, ProviderRefParsed } from "./narration-policy";
import {
  cancelNarrationJob,
  claimMuxDispatch,
  claimTtsDispatch,
  narrationRecoverHttpOutcome,
  pumpNarrationJob,
  recoverNarrationJob,
  submitNarrationJob,
  type FilmNarrationClient
} from "./narration-pump";

/**
 * Narrated-reel execution tests: eligibility, idempotency, exact
 * provider payloads, TTS-to-mux success, cap math, honest failures,
 * reel/caption isolation, private-share exclusion, stale recovery,
 * concurrency truthfulness, and error redaction. Provider traffic uses
 * scripted fakes (synthetic shapes, zero network, zero spend).
 */

const WS = "ws-narration-test";
const REEL = "https://cdn.example/film-reel.mp4";
const AUDIO = "https://cdn.example/narration.mp3";
const NARRATED = "https://cdn.example/film-reel-narrated.mp4";
const SCRIPT = "Welcome to our autumn launch film";
const CAP = 5;

function readyRun(over: Partial<FilmRun> = {}): FilmRun {
  return {
    id: "filmrun_1",
    campaignId: "cmp_nar",
    filmTitle: "Test reel",
    targetDurationSeconds: 45,
    aspectRatio: "9:16",
    budgetCapUsd: 25,
    sceneFingerprint: "fp",
    plannedScenes: [],
    providerSessionId: "permitframe_filmrun_1",
    status: "ready",
    requestedCapability: "submit_creative_job (provider-routed scenes)",
    sceneOutputs: [],
    preservation: {
      requested: "source-guided-generation",
      evidenceLevel: "none",
      note: "Scene prompts reference the approved source media in text."
    },
    reelUrl: REEL,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over
  };
}

function seedDb(run: FilmRun | null, tag: string): { db: Database; campaignId: string } {
  const db = emptyDb();
  const campaignId = `cmp_${tag}`;
  const campaign = {
    id: campaignId,
    title: "narration campaign",
    brand: "brand",
    productName: "product",
    request: {
      platform: "instagram",
      country: "US",
      requestedClaims: [],
      transformation: "video",
      creativeBrief: "A sufficiently long creative brief for the narration probe.",
      qualityProfile: "balanced"
    },
    status: "review",
    preflight: {
      decision: "allow",
      checkedAt: new Date().toISOString(),
      blockers: [],
      allowedClaims: [],
      promptConstraints: ["Be honest."],
      plan: [],
      queriedRights: [],
      queriedFacts: [],
      sparqlPreview: ""
    },
    jobs: [],
    receipts: [],
    ...(run ? { filmRuns: [{ ...run, campaignId }] } : {}),
    creatorId: "c1",
    sourceMediaId: "m1",
    passportId: "p1",
    productFactsId: "f1",
    comments: [],
    captions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  } as Campaign;
  db.campaigns.push(campaign);
  return { db, campaignId };
}

interface ScriptedNarrationClient extends FilmNarrationClient {
  calls: { kind: string; args: unknown }[];
}

function fakeNarration(script: {
  tts?: (ProviderRefParsed | Error)[];
  mux?: (ProviderRefParsed | Error)[];
  status?: (MediaStatusResult | Error)[];
  cancel?: { cancelled: boolean; note: string };
}): ScriptedNarrationClient {
  const calls: { kind: string; args: unknown }[] = [];
  const ttsQueue = [...(script.tts ?? [])];
  const muxQueue = [...(script.mux ?? [])];
  const statusQueue = [...(script.status ?? [])];
  const shift = (queue: (ProviderRefParsed | Error)[], kind: string): ProviderRefParsed => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error(`no scripted ${kind} response`);
    return next;
  };
  return {
    calls,
    submitNarrationTts: async (input) => {
      calls.push({ kind: "tts", args: input });
      return shift(ttsQueue, "tts");
    },
    submitMuxAudio: async (input) => {
      calls.push({ kind: "mux", args: input });
      return shift(muxQueue, "mux");
    },
    getMediaStatus: async (jobId) => {
      calls.push({ kind: "status", args: { jobId } });
      const next = statusQueue.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error("no scripted status response");
      return next;
    },
    cancelProviderJob: async (jobId) => {
      calls.push({ kind: "cancel", args: { jobId } });
      return script.cancel ?? { cancelled: true, note: "Provider confirmed cancellation." };
    }
  };
}

function ttsOk(over: Partial<ProviderRefParsed> = {}): ProviderRefParsed {
  return { providerJobId: "mjob_tts1", statusText: "processing", failed: false, raw: {}, ...over };
}

function muxOk(over: Partial<ProviderRefParsed> = {}): ProviderRefParsed {
  return { providerJobId: "mjob_mux1", statusText: "processing", failed: false, raw: {}, ...over };
}

function mediaStatus(over: Partial<MediaStatusResult>): MediaStatusResult {
  return { status: "processing", terminal: false, raw: {}, ...over };
}

afterEach(() => {
  setRunStore(null);
});

describe("eligibility", () => {
  it("submits only for a completed reel with script, fit, and cap", async () => {
    const { store, read } = memoryStore(seedDb(readyRun(), "elig").db);
    setRunStore(store);
    const result = await submitNarrationJob({
      workspaceId: WS,
      campaignId: "cmp_elig",
      filmRunId: "filmrun_1",
      script: SCRIPT,
      narrationCapUsd: CAP,
      idempotencyKey: "nar-key-1"
    });
    assert.equal(result.created, true);
    assert.ok(result.job);
    assert.equal(result.job.status, "queued");
    assert.equal(result.job.script, SCRIPT);
    assert.equal(result.job.scriptHash, sha256(SCRIPT));
    assert.equal(result.job.narrationCapUsd, 5);
    assert.equal(result.job.sourceReelUrl, REEL);
    assert.ok(result.job.ttsIdempotencyKey);
    assert.ok(result.job.muxIdempotencyKey);
    assert.notEqual(result.job.ttsIdempotencyKey, result.job.muxIdempotencyKey);
    assert.equal((read().campaigns[0].filmRuns?.[0].narrationJobs ?? []).length, 1);
  });

  it("refuses missing reels, bad scripts, over-long narration, and bad caps", async () => {
    const gen = seedDb(readyRun({ status: "generating_scenes" }), "gener");
    const { store: s1 } = memoryStore(gen.db);
    setRunStore(s1);
    const notReady = await submitNarrationJob({ workspaceId: WS, campaignId: gen.campaignId, filmRunId: "filmrun_1", script: SCRIPT, narrationCapUsd: CAP });
    assert.equal(notReady.created, false);
    assert.match(notReady.error ?? "", /completed film reel/);

    const seed = seedDb(readyRun(), "badinput");
    const { store } = memoryStore(seed.db);
    setRunStore(store);
    for (const bad of [
      { script: "   ", narrationCapUsd: CAP, match: /script/i },
      { script: "Hello <b>x</b>", narrationCapUsd: CAP, match: /plain text/ },
      { script: "x".repeat(700), narrationCapUsd: CAP, match: /likely longer than the reel/ },
      { script: SCRIPT, narrationCapUsd: 0, match: /positive|required/i },
      { script: SCRIPT, narrationCapUsd: -2, match: /positive/ },
      { script: SCRIPT, narrationCapUsd: undefined, match: /required/ }
    ]) {
      const r = await submitNarrationJob({ workspaceId: WS, campaignId: seed.campaignId, filmRunId: "filmrun_1", script: bad.script, narrationCapUsd: bad.narrationCapUsd });
      assert.equal(r.created, false);
      assert.match(r.error ?? "", bad.match);
    }
    assert.equal(seed.db.campaigns[0].filmRuns?.[0].narrationJobs?.length ?? 0, 0);
  });

  it("replays idempotency keys and blocks parallel narration flows", async () => {
    const seed = seedDb(readyRun(), "idem");
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const first = await submitNarrationJob({ workspaceId: WS, campaignId: seed.campaignId, filmRunId: "filmrun_1", script: SCRIPT, narrationCapUsd: CAP, idempotencyKey: "nar-k" });
    const replay = await submitNarrationJob({ workspaceId: WS, campaignId: seed.campaignId, filmRunId: "filmrun_1", script: SCRIPT, narrationCapUsd: CAP, idempotencyKey: "nar-k" });
    assert.equal(replay.created, false);
    assert.equal(replay.job?.id, first.job?.id);
    const other = await submitNarrationJob({ workspaceId: WS, campaignId: seed.campaignId, filmRunId: "filmrun_1", script: "Another script", narrationCapUsd: CAP, idempotencyKey: "nar-k2" });
    assert.equal(other.created, false);
    assert.equal(other.job?.id, first.job?.id);
    assert.equal((read().campaigns[0].filmRuns?.[0].narrationJobs ?? []).length, 1);
  });
});

describe("TTS-to-mux success", () => {
  it("walks queued to ready with exact provider payloads", async () => {
    const seed = seedDb(readyRun(), "flow");
    seed.db.campaigns[0].jobs.push({ id: "job_short", status: "ready_to_share" } as never);
    seed.db.campaigns[0].filmRuns = [{
      ...readyRun(),
      campaignId: seed.campaignId,
      captionJobs: [{ id: "filmcap_done", status: "ready" } as never]
    }];
    const jobsBefore = JSON.stringify(seed.db.campaigns[0].jobs);
    const captionsBefore = JSON.stringify(seed.db.campaigns[0].filmRuns?.[0].captionJobs);
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeNarration({
      tts: [ttsOk()],
      mux: [muxOk()],
      status: [
        mediaStatus({ status: "processing" }),
        mediaStatus({ status: "completed", terminal: true, outputUrl: AUDIO, jobId: "mjob_tts1", costUsd: 1.1, capability: "chatterbox-tts" }),
        mediaStatus({ status: "processing" }),
        mediaStatus({ status: "completed", terminal: true, outputUrl: NARRATED, jobId: "mjob_mux1", costUsd: 0.2, capability: "ffmpeg-mux" })
      ]
    });
    const result = await submitNarrationJob({ workspaceId: WS, campaignId: seed.campaignId, filmRunId: "filmrun_1", script: SCRIPT, narrationCapUsd: CAP });
    assert.ok(result.job);
    const jobId = result.job.id;
    const ttsKey = result.job.ttsIdempotencyKey;
    const muxKey = result.job.muxIdempotencyKey;
    await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", jobId, { budgetMs: 20000 }, client);

    const ttsCalls = client.calls.filter((c) => c.kind === "tts");
    const muxCalls = client.calls.filter((c) => c.kind === "mux");
    assert.equal(ttsCalls.length, 1);
    assert.deepEqual(ttsCalls[0].args, {
      prompt: SCRIPT,
      sessionId: `${jobId}-tts`,
      idempotencyKey: ttsKey,
      maxCostUsd: 5,
      excludeUrls: [REEL]
    });
    assert.equal(muxCalls.length, 1);
    assert.deepEqual(muxCalls[0].args, {
      sourceUrl: REEL,
      audioUrl: AUDIO,
      sessionId: `${jobId}-mux`,
      idempotencyKey: muxKey,
      maxCostUsd: 3.9
    });

    const after = read().campaigns[0];
    const run = after.filmRuns?.[0];
    assert.equal(run?.status, "ready");
    assert.equal(run?.reelUrl, REEL);
    const job = run?.narrationJobs?.[0];
    assert.equal(job?.status, "ready");
    assert.equal(job?.ttsJobId, "mjob_tts1");
    assert.equal(job?.muxJobId, "mjob_mux1");
    assert.equal(job?.narrationAudioUrl, AUDIO);
    assert.equal(job?.narratedUrl, NARRATED);
    assert.equal(job?.ttsCostUsd, 1.1);
    assert.equal(job?.muxCostUsd, 0.2);
    assert.equal(job?.actualCapability, "ffmpeg-mux");
    assert.ok(job?.receiptId);
    assert.equal(after.receipts.length, 1);
    const receipt = after.receipts[0];
    assert.equal(receipt.label, "Campaign film reel · narration");
    assert.equal(receipt.mediaType, "video");
    assert.equal(receipt.format, "9:16");
    assert.equal(receipt.outputUrl, NARRATED);
    assert.equal(receipt.derivedFromFilmRunId, "filmrun_1");
    assert.equal(receipt.sourceReelUrl, REEL);
    assert.equal(receipt.role, "tts");
    assert.equal(receipt.visibility, "private");
    assert.equal(receipt.ual, undefined);
    assert.equal(receipt.storageStatus, undefined);
    assert.equal(receipt.costUsd, 1.3);
    assert.ok(!JSON.stringify(receipt).includes(SCRIPT.slice(0, 20)), "script text must not leak into the receipt");
    assert.ok(!JSON.stringify(read().events).includes(SCRIPT.slice(0, 20)), "script text must not leak into events");
    assert.equal(JSON.stringify(after.jobs), jobsBefore);
    assert.equal(JSON.stringify(after.filmRuns?.[0].captionJobs), captionsBefore);
  });

  it("inline TTS audio proceeds to mux without polling", async () => {
    const seed = seedDb(readyRun(), "inline");
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeNarration({
      tts: [ttsOk({ providerJobId: undefined, outputUrl: AUDIO, costUsd: 0.8 })],
      mux: [muxOk({ providerJobId: undefined, outputUrl: NARRATED, costUsd: 0.1 })]
    });
    const result = await submitNarrationJob({ workspaceId: WS, campaignId: seed.campaignId, filmRunId: "filmrun_1", script: SCRIPT, narrationCapUsd: CAP });
    assert.ok(result.job);
    await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", result.job.id, { budgetMs: 20000 }, client);
    assert.equal(client.calls.filter((c) => c.kind === "status").length, 0);
    const job = read().campaigns[0].filmRuns?.[0].narrationJobs?.[0];
    assert.equal(job?.status, "ready");
    assert.equal(job?.narratedUrl, NARRATED);
  });
});

describe("cap handling", () => {
  it("refuses mux when TTS cost is unknown - never unbounded", async () => {
    const seed = seedDb(readyRun(), "nocost");
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeNarration({
      tts: [ttsOk()],
      status: [mediaStatus({ status: "completed", terminal: true, outputUrl: AUDIO, jobId: "mjob_tts1" })]
    });
    const result = await submitNarrationJob({ workspaceId: WS, campaignId: seed.campaignId, filmRunId: "filmrun_1", script: SCRIPT, narrationCapUsd: CAP });
    assert.ok(result.job);
    await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", result.job.id, { budgetMs: 20000 }, client);
    const job = read().campaigns[0].filmRuns?.[0].narrationJobs?.[0];
    assert.equal(job?.status, "failed");
    assert.match(job?.error ?? "", /unbounded mux/);
    assert.equal(job?.narrationAudioUrl, AUDIO);
    assert.equal(client.calls.filter((c) => c.kind === "mux").length, 0);
    assert.equal(read().campaigns[0].receipts.length, 0);
  });

  it("refuses mux when known TTS cost exhausts the cap", async () => {
    const seed = seedDb(readyRun(), "exhausted");
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeNarration({
      tts: [ttsOk()],
      status: [mediaStatus({ status: "completed", terminal: true, outputUrl: AUDIO, jobId: "mjob_tts1", costUsd: 5 })]
    });
    const result = await submitNarrationJob({ workspaceId: WS, campaignId: seed.campaignId, filmRunId: "filmrun_1", script: SCRIPT, narrationCapUsd: CAP });
    assert.ok(result.job);
    await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", result.job.id, { budgetMs: 20000 }, client);
    const job = read().campaigns[0].filmRuns?.[0].narrationJobs?.[0];
    assert.equal(job?.status, "failed");
    assert.match(job?.error ?? "", /no budget remains/);
    assert.equal(client.calls.filter((c) => c.kind === "mux").length, 0);
  });
});

describe("honest failures keep the reel intact", () => {
  it("empty TTS response leaves a claimed job - unknown outcome, never failed", async () => {
    const seed = seedDb(readyRun(), "emptytts");
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeNarration({ tts: [{ providerJobId: undefined, statusText: "", failed: false, raw: {} }] });
    const result = await submitNarrationJob({ workspaceId: WS, campaignId: seed.campaignId, filmRunId: "filmrun_1", script: SCRIPT, narrationCapUsd: CAP });
    assert.ok(result.job);
    await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", result.job.id, { budgetMs: 20000 }, client);
    const after = read().campaigns[0];
    const job = after.filmRuns?.[0].narrationJobs?.[0];
    assert.equal(job?.status, "generating_narration");
    assert.ok(job?.ttsDispatchedAt, "durable TTS claim persisted before the call");
    assert.ok(job?.dispatchStartedAt, "dispatch claim timestamp persisted");
    assert.equal(after.receipts.length, 0);
    assert.equal(after.filmRuns?.[0].reelUrl, REEL);
    // A later pump must not re-submit the claimed request.
    await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", result.job.id, { budgetMs: 5000 }, client);
    assert.equal(client.calls.filter((c) => c.kind === "tts").length, 1);
  });

  it("provider-declared TTS failure persists failed state with ids and cost", async () => {
    const seed = seedDb(readyRun(), "declfail");
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeNarration({
      tts: [{
        providerJobId: "mjob_tts9",
        statusText: "failed <script>https://evil.example/x?token=abc</script>",
        failed: true,
        costUsd: 0.3,
        capability: "chatterbox-tts",
        raw: {}
      }]
    });
    const result = await submitNarrationJob({ workspaceId: WS, campaignId: seed.campaignId, filmRunId: "filmrun_1", script: SCRIPT, narrationCapUsd: CAP });
    assert.ok(result.job);
    await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", result.job.id, { budgetMs: 20000 }, client);
    const after = read().campaigns[0];
    const job = after.filmRuns?.[0].narrationJobs?.[0];
    assert.equal(job?.status, "failed");
    assert.equal(job?.ttsJobId, "mjob_tts9");
    assert.equal(job?.ttsCostUsd, 0.3);
    assert.equal(job?.actualCapability, "chatterbox-tts");
    assert.ok(job?.finishedAt);
    assert.equal(job?.error, "Narration generation failed at the provider before delivery. The original reel is intact.");
    assert.ok(!(job?.error ?? "").includes("evil.example"), "raw provider text must not leak");
    assert.equal(after.receipts.length, 0);
    assert.equal(after.filmRuns?.[0].reelUrl, REEL);
    // Failed with a tracked id: no auto-submit, no ordinary retry path.
    await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", result.job.id, { budgetMs: 5000 }, client);
    assert.equal(client.calls.filter((c) => c.kind === "tts").length, 1);
  });

  it("terminal TTS poll failure fails honestly", async () => {
    const seed = seedDb(readyRun(), "ttsfail");
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeNarration({
      tts: [ttsOk()],
      status: [mediaStatus({ status: "failed", terminal: true })]
    });
    const result = await submitNarrationJob({ workspaceId: WS, campaignId: seed.campaignId, filmRunId: "filmrun_1", script: SCRIPT, narrationCapUsd: CAP });
    assert.ok(result.job);
    await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", result.job.id, { budgetMs: 20000 }, client);
    const after = read().campaigns[0];
    assert.equal(after.filmRuns?.[0].narrationJobs?.[0].status, "failed");
    assert.match(after.filmRuns?.[0].narrationJobs?.[0].error ?? "", /before delivery/);
    assert.equal(after.receipts.length, 0);
  });

  it("empty mux response leaves a claimed job - unknown outcome, never failed", async () => {
    const seed = seedDb(readyRun(), "emptymux");
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeNarration({
      tts: [ttsOk()],
      mux: [{ providerJobId: undefined, statusText: "", failed: false, raw: {} }],
      status: [mediaStatus({ status: "completed", terminal: true, outputUrl: AUDIO, jobId: "mjob_tts1", costUsd: 1 })]
    });
    const result = await submitNarrationJob({ workspaceId: WS, campaignId: seed.campaignId, filmRunId: "filmrun_1", script: SCRIPT, narrationCapUsd: CAP });
    assert.ok(result.job);
    await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", result.job.id, { budgetMs: 20000 }, client);
    const after = read().campaigns[0];
    const job = after.filmRuns?.[0].narrationJobs?.[0];
    assert.equal(job?.status, "muxing");
    assert.ok(job?.muxDispatchedAt, "durable mux claim persisted before the call");
    assert.equal(job?.narrationAudioUrl, AUDIO);
    assert.equal(after.receipts.length, 0);
    // A later pump must not re-submit the claimed mux request.
    await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", result.job.id, { budgetMs: 5000 }, client);
    assert.equal(client.calls.filter((c) => c.kind === "mux").length, 1);
  });

  it("transport failures leave claims in place with no persisted secrets", async () => {
    const seed = seedDb(readyRun(), "redact");
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeNarration({ tts: [new Error("create_media failed: Bearer tok_abc123 sk-live-x https://hooks.example/x")] });
    const result = await submitNarrationJob({ workspaceId: WS, campaignId: seed.campaignId, filmRunId: "filmrun_1", script: SCRIPT, narrationCapUsd: CAP });
    assert.ok(result.job);
    await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", result.job.id, { budgetMs: 20000 }, client);
    const job = read().campaigns[0].filmRuns?.[0].narrationJobs?.[0];
    assert.equal(job?.status, "generating_narration");
    assert.ok(job?.ttsDispatchedAt, "claim persisted before the failed call");
    assert.equal(job?.error, undefined);
    assert.ok(!JSON.stringify(job).includes("tok_abc123"));
    assert.ok(!JSON.stringify(job).includes("sk-live-x"));
    assert.ok(!JSON.stringify(job).includes("hooks.example"));
    assert.equal(read().campaigns[0].receipts.length, 0);
    // No automatic resubmission of the claimed request.
    await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", result.job.id, { budgetMs: 5000 }, client);
    assert.equal(client.calls.filter((c) => c.kind === "tts").length, 1);
  });

  it("hostile poll status text never reaches persisted errors", async () => {
    const seed = seedDb(readyRun(), "hostilepoll");
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeNarration({
      tts: [ttsOk()],
      status: [mediaStatus({ status: "FAILED <img src=x onerror=alert(1)> https://evil.example/s?k=v", terminal: true })]
    });
    const result = await submitNarrationJob({ workspaceId: WS, campaignId: seed.campaignId, filmRunId: "filmrun_1", script: SCRIPT, narrationCapUsd: CAP });
    assert.ok(result.job);
    await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", result.job.id, { budgetMs: 20000 }, client);
    const job = read().campaigns[0].filmRuns?.[0].narrationJobs?.[0];
    assert.equal(job?.status, "failed");
    assert.ok(!(job?.error ?? "").includes("evil.example"));
    assert.ok(!(job?.error ?? "").includes("onerror"));
    assert.match(job?.error ?? "", /provider-reported state/);
  });
});

describe("private share exclusion", () => {
  it("narrated receipts never reach client delivery", async () => {
    const seed = seedDb(readyRun(), "share");
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeNarration({
      tts: [ttsOk({ providerJobId: undefined, outputUrl: AUDIO, costUsd: 0.5 })],
      mux: [muxOk({ providerJobId: undefined, outputUrl: NARRATED, costUsd: 0.1 })]
    });
    const result = await submitNarrationJob({ workspaceId: WS, campaignId: seed.campaignId, filmRunId: "filmrun_1", script: SCRIPT, narrationCapUsd: CAP });
    assert.ok(result.job);
    await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", result.job.id, { budgetMs: 20000 }, client);
    const campaign = read().campaigns[0];
    assert.equal(campaign.receipts.length, 1);
    assert.deepEqual(publicOutputsForShare(campaign, null), []);
  });
});

const STALE_AT = new Date(Date.now() - 31 * 60 * 1000).toISOString();

function staleNarrationJob(over: Partial<FilmNarrationJob> = {}): FilmNarrationJob {
  return {
    id: "filmnar_stale",
    campaignId: "cmp_x",
    filmRunId: "filmrun_1",
    script: SCRIPT,
    scriptHash: sha256(SCRIPT),
    estimatedSeconds: 3,
    narrationCapUsd: CAP,
    sourceReelUrl: REEL,
    status: "generating_narration",
    ttsIdempotencyKey: "tts_old",
    muxIdempotencyKey: "mux_old",
    dispatchStartedAt: STALE_AT,
    ttsDispatchedAt: STALE_AT,
    attempt: 1,
    createdAt: STALE_AT,
    updatedAt: STALE_AT,
    ...over
  };
}

function seedNarrationDb(tag: string, jobs: FilmNarrationJob[]): { db: Database; campaignId: string } {
  const seed = seedDb(readyRun(), tag);
  seed.db.campaigns[0].filmRuns = [{ ...readyRun(), campaignId: seed.campaignId, narrationJobs: jobs }];
  return seed;
}

describe("stale recovery", () => {
  it("pump never dispatches a stale claimed job", async () => {
    const { store, read } = memoryStore(seedNarrationDb("stalepump", [staleNarrationJob()]).db);
    setRunStore(store);
    const client = fakeNarration({ tts: [{ providerJobId: "mjob_x", statusText: "", failed: false, raw: {} }], mux: [] });
    const result = await pumpNarrationJob(WS, "cmp_stalepump", "filmrun_1", "filmnar_stale", { budgetMs: 5000 }, client);
    assert.equal(result.pumped, false);
    assert.equal(result.reason, "stale-claim");
    assert.equal(client.calls.length, 0);
    const job = read().campaigns[0].filmRuns?.[0].narrationJobs?.[0];
    assert.equal(job?.status, "generating_narration");
    assert.equal(job?.dispatchStartedAt, STALE_AT);
  });

  it("recovery preserves the original and mints a distinct fresh job", async () => {
    const seed = seedNarrationDb("recover", [staleNarrationJob({ ttsJobId: "mjob_old", ttsCostUsd: 0.7 })]);
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const recovered = await recoverNarrationJob(WS, seed.campaignId, "filmrun_1", "filmnar_stale");
    if (!recovered.ok) throw new Error(`unexpected recovery failure: ${recovered.error}`);
    assert.notEqual(recovered.job.id, "filmnar_stale");
    assert.equal(recovered.job.status, "queued");
    assert.equal(recovered.job.script, SCRIPT);
    assert.equal(recovered.job.scriptHash, sha256(SCRIPT));
    assert.equal(recovered.job.narrationCapUsd, CAP);
    assert.notEqual(recovered.job.ttsIdempotencyKey, "tts_old");
    assert.notEqual(recovered.job.muxIdempotencyKey, "mux_old");
    assert.notEqual(recovered.job.idempotencyKey, undefined);
    const jobs = read().campaigns[0].filmRuns?.[0].narrationJobs ?? [];
    assert.equal(jobs.length, 2);
    const preserved = jobs.find((j) => j.id === "filmnar_stale");
    assert.equal(preserved?.status, "outcome_unknown");
    assert.ok(preserved?.outcomeUnknownAt);
    assert.equal(preserved?.ttsJobId, "mjob_old");
    assert.equal(preserved?.ttsCostUsd, 0.7);
    assert.equal(read().campaigns[0].receipts.length, 0);
    assert.equal(read().campaigns[0].filmRuns?.[0].reelUrl, REEL);
  });

  it("two simultaneous recoveries: one success, one conflict, single write", async () => {
    const seed = seedNarrationDb("race", [staleNarrationJob()]);
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const [a, b] = await Promise.all([
      recoverNarrationJob(WS, seed.campaignId, "filmrun_1", "filmnar_stale"),
      recoverNarrationJob(WS, seed.campaignId, "filmrun_1", "filmnar_stale")
    ]);
    const winner = a.ok ? a : b.ok ? b : undefined;
    const loser = a.ok ? b : a;
    if (!winner?.ok) throw new Error("one recovery must succeed");
    if (loser.ok) throw new Error("the other recovery must fail");
    assert.equal(loser.conflict, true);
    assert.ok(!("job" in loser));
    const jobs = read().campaigns[0].filmRuns?.[0].narrationJobs ?? [];
    assert.equal(jobs.length, 2);
    assert.equal(jobs.filter((j) => j.status === "outcome_unknown").length, 1);
    assert.deepEqual(
      narrationRecoverHttpOutcome(loser),
      {
        status: 409,
        body: { error: "This narration request was already recovered or changed. Refresh once to see its current status." }
      }
    );
  });

  it("the loser cannot cause a provider dispatch", async () => {
    const seed = seedNarrationDb("racepump", [staleNarrationJob()]);
    const { store } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeNarration({
      tts: [ttsOk()],
      mux: [muxOk()],
      status: [
        mediaStatus({ status: "processing" }),
        mediaStatus({ status: "completed", terminal: true, outputUrl: AUDIO, jobId: "mjob_tts1", costUsd: 1 }),
        mediaStatus({ status: "processing" }),
        mediaStatus({ status: "completed", terminal: true, outputUrl: NARRATED, jobId: "mjob_mux1", costUsd: 0.1 })
      ]
    });
    const [a, b] = await Promise.all([
      recoverNarrationJob(WS, seed.campaignId, "filmrun_1", "filmnar_stale"),
      recoverNarrationJob(WS, seed.campaignId, "filmrun_1", "filmnar_stale")
    ]);
    const winner = a.ok ? a : b;
    if (!winner.ok) throw new Error("one recovery must succeed");
    await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", winner.job.id, { budgetMs: 20000 }, client);
    assert.equal(client.calls.filter((c) => c.kind === "tts").length, 1);
    await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", "filmnar_stale", { budgetMs: 5000 }, client);
    assert.equal(client.calls.filter((c) => c.kind === "tts").length, 1);
    assert.equal(client.calls.filter((c) => c.kind === "mux").length, 1);
  });
});

describe("crash simulations never auto-resubmit claimed phases", () => {
  it("dies during the mux call: claim stands, later pump submits nothing", async () => {
    const seed = seedDb(readyRun(), "muxcrash");
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeNarration({
      tts: [ttsOk()],
      mux: [new Error("connection reset during mux dispatch")],
      status: [mediaStatus({ status: "completed", terminal: true, outputUrl: AUDIO, jobId: "mjob_tts1", costUsd: 1 })]
    });
    const result = await submitNarrationJob({ workspaceId: WS, campaignId: seed.campaignId, filmRunId: "filmrun_1", script: SCRIPT, narrationCapUsd: CAP });
    assert.ok(result.job);
    await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", result.job.id, { budgetMs: 20000 }, client);
    const job = read().campaigns[0].filmRuns?.[0].narrationJobs?.[0];
    assert.equal(job?.status, "muxing");
    assert.ok(job?.muxDispatchedAt, "durable mux claim persisted before the call");
    assert.equal(job?.narrationAudioUrl, AUDIO);
    assert.equal(read().campaigns[0].receipts.length, 0);
    await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", result.job.id, { budgetMs: 5000 }, client);
    assert.equal(client.calls.filter((c) => c.kind === "mux").length, 1);
    assert.equal(client.calls.filter((c) => c.kind === "tts").length, 1);
  });
});

describe("ready finalization is atomic with exactly one receipt", () => {
  it("reconciles a legacy ready row once and never duplicates it", async () => {
    const seed = seedDb(readyRun(), "reconcile");
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const submitted = await submitNarrationJob({ workspaceId: WS, campaignId: seed.campaignId, filmRunId: "filmrun_1", script: SCRIPT, narrationCapUsd: CAP });
    assert.ok(submitted.job);
    // Simulate an interrupted legacy row: usable output, ready, no receipt.
    await withCampaignLock(seed.campaignId, () =>
      writeWorkspace(WS, (d: Database) => {
        const target = d.campaigns.find((x) => x.id === seed.campaignId)?.filmRuns?.[0].narrationJobs?.[0];
        if (!target) throw new Error("seed job missing");
        target.status = "ready";
        target.narratedUrl = NARRATED;
        target.finishedAt = new Date().toISOString();
      })
    );
    const client = fakeNarration({});
    const first = await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", submitted.job.id, { budgetMs: 5000 }, client);
    assert.equal(first.reason, "reconciled");
    assert.equal(client.calls.length, 0);
    const after = read().campaigns[0];
    assert.equal(after.receipts.length, 1);
    assert.equal(after.receipts[0].outputUrl, NARRATED);
    assert.equal(after.receipts[0].visibility, "private");
    assert.equal(after.filmRuns?.[0].narrationJobs?.[0].receiptId, after.receipts[0].id);
    // Second pass changes nothing.
    const second = await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", submitted.job.id, { budgetMs: 5000 }, client);
    assert.equal(second.reason, "settled");
    assert.equal(read().campaigns[0].receipts.length, 1);
    assert.deepEqual(publicOutputsForShare(read().campaigns[0], null), []);
  });
});

describe("atomic dispatch claims across concurrent pumps", () => {
  it("two pumps on a queued job: one TTS claim, one provider call, loser already-claimed", async () => {
    const seed = seedDb(readyRun(), "raceclaim");
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeNarration({
      tts: [ttsOk()],
      status: [mediaStatus({ status: "processing" })]
    });
    const submitted = await submitNarrationJob({ workspaceId: WS, campaignId: seed.campaignId, filmRunId: "filmrun_1", script: SCRIPT, narrationCapUsd: CAP });
    assert.ok(submitted.job);
    const jobId = submitted.job.id;
    const [a, b] = await Promise.all([
      pumpNarrationJob(WS, seed.campaignId, "filmrun_1", jobId, { budgetMs: 5000 }, client),
      pumpNarrationJob(WS, seed.campaignId, "filmrun_1", jobId, { budgetMs: 5000 }, client)
    ]);
    assert.equal(client.calls.filter((c) => c.kind === "tts").length, 1);
    const jobs = read().campaigns[0].filmRuns?.[0].narrationJobs ?? [];
    assert.equal(jobs.length, 1);
    assert.ok(jobs[0].ttsDispatchedAt, "exactly one durable TTS claim");
    assert.ok(a.pumped || b.pumped);
  });

  it("claim helpers serialize: one claimed, one already-claimed, no duplicate events", async () => {
    const seed = seedDb(readyRun(), "racehelper");
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const submitted = await submitNarrationJob({ workspaceId: WS, campaignId: seed.campaignId, filmRunId: "filmrun_1", script: SCRIPT, narrationCapUsd: CAP });
    assert.ok(submitted.job);
    const [a, b] = await Promise.all([
      claimTtsDispatch(WS, seed.campaignId, "filmrun_1", submitted.job.id),
      claimTtsDispatch(WS, seed.campaignId, "filmrun_1", submitted.job.id)
    ]);
    const winner = a.claimed ? a : b.claimed ? b : undefined;
    const loser = a.claimed ? b : a;
    if (!winner?.claimed) throw new Error("one claim must succeed");
    if (loser.claimed) throw new Error("the other claim must fail");
    assert.equal(loser.reason, "already-claimed");
    assert.ok(winner.job.ttsDispatchedAt);
    assert.equal(winner.job.status, "generating_narration");
    const stored = read().campaigns[0].filmRuns?.[0].narrationJobs ?? [];
    assert.equal(stored.length, 1);
    assert.equal(stored.filter((j) => j.status === "generating_narration").length, 1);
  });

  it("two pumps on a waiting job: one mux claim, one provider call", async () => {
    const seed = seedDb(readyRun(), "racemux");
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeNarration({
      mux: [muxOk()],
      status: [mediaStatus({ status: "processing" })]
    });
    const submitted = await submitNarrationJob({ workspaceId: WS, campaignId: seed.campaignId, filmRunId: "filmrun_1", script: SCRIPT, narrationCapUsd: CAP });
    assert.ok(submitted.job);
    // Advance to waiting_for_narration with known audio + cost without a mux call.
    await withCampaignLock(seed.campaignId, () =>
      writeWorkspace(WS, (d: Database) => {
        const target = d.campaigns.find((x) => x.id === seed.campaignId)?.filmRuns?.[0].narrationJobs?.[0];
        if (!target) throw new Error("seed job missing");
        target.status = "waiting_for_narration";
        target.ttsJobId = "mjob_tts1";
        target.ttsCostUsd = 1;
        target.narrationAudioUrl = AUDIO;
        target.ttsDispatchedAt = new Date().toISOString();
        target.dispatchStartedAt = target.ttsDispatchedAt;
      })
    );
    const [a, b] = await Promise.all([
      pumpNarrationJob(WS, seed.campaignId, "filmrun_1", submitted.job.id, { budgetMs: 5000 }, client),
      pumpNarrationJob(WS, seed.campaignId, "filmrun_1", submitted.job.id, { budgetMs: 5000 }, client)
    ]);
    assert.equal(client.calls.filter((c) => c.kind === "mux").length, 1);
    const job = read().campaigns[0].filmRuns?.[0].narrationJobs?.[0];
    assert.equal(job?.status, "muxing");
    assert.ok(job?.muxDispatchedAt, "exactly one durable mux claim");
    assert.ok(a.pumped || b.pumped);
  });

  it("an already-muxing row never submits again", async () => {
    const seed = seedNarrationDb("nomuxresubmit", [
      staleNarrationJob({ status: "muxing", muxDispatchedAt: new Date().toISOString(), muxJobId: "mjob_mux9" })
    ]);
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeNarration({ mux: [muxOk()], status: [mediaStatus({ status: "processing" })] });
    const [a, b] = await Promise.all([
      claimMuxDispatch(WS, seed.campaignId, "filmrun_1", "filmnar_stale"),
      claimMuxDispatch(WS, seed.campaignId, "filmrun_1", "filmnar_stale")
    ]);
    assert.ok(!a.claimed && !b.claimed);
    await pumpNarrationJob(WS, seed.campaignId, "filmrun_1", "filmnar_stale", { budgetMs: 5000 }, client);
    // The single poll observes processing; no mux submission occurs.
    assert.equal(client.calls.filter((c) => c.kind === "mux").length, 0);
    assert.equal(read().campaigns[0].filmRuns?.[0].narrationJobs?.[0].status, "muxing");
  });
});

describe("cancel isolation", () => {  it("cancels tracked phase ids only and preserves the reel", async () => {
    const seed = seedNarrationDb("cancel", [staleNarrationJob({ dispatchStartedAt: new Date().toISOString(), ttsJobId: "mjob_tts9" })]);
    seed.db.campaigns[0].jobs.push({ id: "job_short", status: "ready_to_share" } as never);
    seed.db.campaigns[0].receipts.push({ id: "rcpt_short" } as never);
    const jobsBefore = JSON.stringify(seed.db.campaigns[0].jobs);
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeNarration({});
    const cancelled = await cancelNarrationJob(WS, seed.campaignId, "filmrun_1", "filmnar_stale", client);
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.providerConfirmed, true);
    assert.deepEqual(client.calls.filter((c) => c.kind === "cancel").map((c) => (c.args as { jobId: string }).jobId), ["mjob_tts9"]);
    const after = read().campaigns[0];
    assert.equal(after.filmRuns?.[0].narrationJobs?.[0].status, "cancelled");
    assert.equal(after.filmRuns?.[0].reelUrl, REEL);
    assert.equal(JSON.stringify(after.jobs), jobsBefore);
    assert.equal(after.receipts.length, 1);
  });
});
