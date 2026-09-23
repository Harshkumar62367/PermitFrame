import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Campaign, Database } from "../types";
import { emptyDb } from "../store";
import { setRunStore, memoryStore } from "./run-store";
import {
  buildTranscribeArgs,
  canRetryCaptionJob,
  captionDisplayStatus,
  captionRecoveryError,
  isCaptionStale,
  OUTCOME_UNKNOWN_COPY,
  RECOVERY_CONFLICT_MESSAGE,
  parseTranscribeResult,
  validateCaptionLanguage,
  type FilmCaptionJob,
  type TranscribeParsed
} from "./film-captions";
import {
  cancelCaptionJob,
  findCaptionJobView,
  pumpCaptionJob,
  recoverCaptionJob,
  recoverHttpOutcome,
  submitCaptionJob,
  type FilmCaptionClient
} from "./film-caption-pump";
import type { FilmRun } from "./film-run";

/**
 * Burn-captions finishing tests: eligibility + confirmation gate,
 * idempotent retry/recovery, untouched originals, transcript-only honesty,
 * linked derived receipts, honest failures, cancel isolation, and legacy
 * safety. Provider traffic uses scripted fakes (synthetic shapes, zero
 * network, zero spend); the workspace uses the in-memory run-store seam.
 */

const WS = "ws-caption-test";
const REEL = "https://cdn.example/film-reel.mp4";
const CAPTIONED = "https://cdn.example/film-reel-captions.mp4";

function readyRun(over: Partial<FilmRun> = {}): FilmRun {
  return {
    id: "filmrun_1",
    campaignId: "cmp_cap",
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
    title: "caption campaign",
    brand: "brand",
    productName: "product",
    request: {
      platform: "instagram",
      country: "US",
      requestedClaims: [],
      transformation: "video",
      creativeBrief: "A sufficiently long creative brief for the caption probe.",
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

interface ScriptedCaptionClient extends FilmCaptionClient {
  calls: { kind: string; args: unknown }[];
}

function fakeCaption(script: {
  transcribe?: (TranscribeParsed | Error)[];
  cancel?: { cancelled: boolean; note: string };
}): ScriptedCaptionClient {
  const calls: { kind: string; args: unknown }[] = [];
  const queue = [...(script.transcribe ?? [])];
  return {
    calls,
    transcribeForCaptions: async (input) => {
      calls.push({ kind: "transcribe", args: input });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error("no scripted transcribe response");
      return next;
    },
    cancelProviderJob: async (jobId) => {
      calls.push({ kind: "cancel", args: { jobId } });
      return script.cancel ?? { cancelled: true, note: "Provider confirmed cancellation." };
    }
  };
}

function transcribed(over: Partial<TranscribeParsed> = {}): TranscribeParsed {
  return {
    outputUrl: CAPTIONED,
    transcriptText: "hello world",
    burnPending: false,
    failed: false,
    statusText: "completed",
    raw: {},
    ...over
  };
}

afterEach(() => {
  setRunStore(null);
});

describe("eligibility and confirmation gate", () => {
  it("submits only for a completed reel with a durable HTTPS URL", async () => {
    const { store, read } = memoryStore(seedDb(readyRun(), "elig").db);
    setRunStore(store);
    const result = await submitCaptionJob({
      workspaceId: WS,
      campaignId: "cmp_elig",
      filmRunId: "filmrun_1",
      language: "en",
      idempotencyKey: "cap-key-1"
    });
    assert.equal(result.created, true);
    assert.ok(result.job);
    assert.equal(result.job.status, "queued");
    assert.equal(result.job.language, "en");
    assert.equal(result.job.sourceReelUrl, REEL);
    assert.equal(result.job.idempotencyKey, "cap-key-1");
    assert.equal((read().campaigns[0].filmRuns?.[0].captionJobs ?? []).length, 1);
  });

  it("refuses runs without a delivered reel", async () => {
    const cases: { tag: string; run: FilmRun }[] = [
      { tag: "notready", run: readyRun({ status: "generating_scenes" }) },
      { tag: "nourl", run: readyRun({ reelUrl: undefined }) },
      { tag: "insecure", run: readyRun({ reelUrl: "http://insecure.example/r.mp4" }) }
    ];
    for (const { tag, run } of cases) {
      const seed = seedDb(run, tag);
      const { store, read } = memoryStore(seed.db);
      setRunStore(store);
      const result = await submitCaptionJob({
        workspaceId: WS,
        campaignId: seed.campaignId,
        filmRunId: "filmrun_1",
        language: "en"
      });
      assert.equal(result.created, false, tag);
      assert.match(result.error ?? "", /completed film reel/, tag);
      assert.equal((read().campaigns[0].filmRuns?.[0].captionJobs ?? []).length, 0, tag);
    }
  });

  it("requires an explicit language - no auto-detect default", async () => {
    const { store } = memoryStore(seedDb(readyRun(), "lang").db);
    setRunStore(store);
    for (const language of ["", "  ", "english-is-too-long", "e1", 42, undefined]) {
      const result = await submitCaptionJob({
        workspaceId: WS,
        campaignId: "cmp_lang",
        filmRunId: "filmrun_1",
        language: language as unknown
      });
      assert.equal(result.created, false);
      assert.match(result.error ?? "", /language/i);
    }
    assert.equal(validateCaptionLanguage("en").ok, true);
    assert.equal(validateCaptionLanguage("es").ok, true);
    assert.equal(validateCaptionLanguage("").ok, false);
  });

  it("sends only source_url, burn:true, and language", async () => {
    const { store } = memoryStore(seedDb(readyRun(), "args").db);
    setRunStore(store);
    const client = fakeCaption({ transcribe: [transcribed()] });
    const result = await submitCaptionJob({ workspaceId: WS, campaignId: "cmp_args", filmRunId: "filmrun_1", language: "es" });
    assert.ok(result.job);
    await pumpCaptionJob(WS, "cmp_args", "filmrun_1", result.job.id, client);
    const calls = client.calls.filter((c) => c.kind === "transcribe");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, { sourceUrl: REEL, language: "es" });
    assert.deepEqual(buildTranscribeArgs(REEL, "en"), { source_url: REEL, burn: true, language: "en" });
  });
});

describe("idempotent retry and recovery", () => {
  it("replays the same idempotency key and blocks parallel caption spend", async () => {
    const { store, read } = memoryStore(seedDb(readyRun(), "idem").db);
    setRunStore(store);
    const first = await submitCaptionJob({ workspaceId: WS, campaignId: "cmp_idem", filmRunId: "filmrun_1", language: "en", idempotencyKey: "cap-k" });
    const replay = await submitCaptionJob({ workspaceId: WS, campaignId: "cmp_idem", filmRunId: "filmrun_1", language: "en", idempotencyKey: "cap-k" });
    assert.equal(replay.created, false);
    assert.equal(replay.job?.id, first.job?.id);
    const other = await submitCaptionJob({ workspaceId: WS, campaignId: "cmp_idem", filmRunId: "filmrun_1", language: "fr", idempotencyKey: "cap-k2" });
    assert.equal(other.created, false);
    assert.equal(other.job?.id, first.job?.id);
    assert.equal((read().campaigns[0].filmRuns?.[0].captionJobs ?? []).length, 1);
  });

  it("failed jobs without a provider id resume through the same record", async () => {
    const { store, read } = memoryStore(seedDb(readyRun(), "retry").db);
    setRunStore(store);
    const client = fakeCaption({
      transcribe: [new Error("socket hang up"), transcribed()]
    });
    const result = await submitCaptionJob({ workspaceId: WS, campaignId: "cmp_retry", filmRunId: "filmrun_1", language: "en" });
    assert.ok(result.job);
    const jobId = result.job.id;
    await pumpCaptionJob(WS, "cmp_retry", "filmrun_1", jobId, client);
    assert.equal(read().campaigns[0].filmRuns?.[0].captionJobs?.[0].status, "failed");
    // Retry route resets failed-no-id jobs to queued; the pump then reuses the record.
    const { writeWorkspace } = await import("./run-store");
    const { withCampaignLock } = await import("./mutex");
    await withCampaignLock("cmp_retry", () =>
      writeWorkspace(WS, (d: Database) => {
        const target = d.campaigns.find((x) => x.id === "cmp_retry")?.filmRuns?.[0].captionJobs?.[0];
        if (target) {
          target.status = "queued";
          target.error = undefined;
        }
      })
    );
    await pumpCaptionJob(WS, "cmp_retry", "filmrun_1", jobId, client);
    const job = read().campaigns[0].filmRuns?.[0].captionJobs?.[0];
    assert.equal(job?.status, "ready");
    assert.equal(client.calls.filter((c) => c.kind === "transcribe").length, 2);
  });

  it("pump never redispatches settled or tracked jobs", async () => {
    const { store } = memoryStore(seedDb(readyRun(), "settled").db);
    setRunStore(store);
    const client = fakeCaption({ transcribe: [transcribed({ providerJobId: "tjob_1" })] });
    const result = await submitCaptionJob({ workspaceId: WS, campaignId: "cmp_settled", filmRunId: "filmrun_1", language: "en" });
    assert.ok(result.job);
    await pumpCaptionJob(WS, "cmp_settled", "filmrun_1", result.job.id, client);
    await pumpCaptionJob(WS, "cmp_settled", "filmrun_1", result.job.id, client);
    assert.equal(client.calls.filter((c) => c.kind === "transcribe").length, 1);
  });
});

describe("ready creates a linked derived receipt, reel untouched", () => {
  it("receipt links the reel and carries no DKG or storage claims", async () => {
    const seed = seedDb(readyRun(), "receipt");
    seed.db.campaigns[0].jobs.push({ id: "job_short", status: "ready_to_share" } as never);
    const jobsBefore = JSON.stringify(seed.db.campaigns[0].jobs);
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeCaption({
      transcribe: [transcribed({ costUsd: 0.42, durationSeconds: 45, actualWidth: 1080, actualHeight: 1920, capability: "wizper" })]
    });
    const result = await submitCaptionJob({ workspaceId: WS, campaignId: "cmp_receipt", filmRunId: "filmrun_1", language: "en" });
    assert.ok(result.job);
    await pumpCaptionJob(WS, "cmp_receipt", "filmrun_1", result.job.id, client);
    const after = read().campaigns[0];
    const run = after.filmRuns?.[0];
    assert.equal(run?.status, "ready");
    assert.equal(run?.reelUrl, REEL);
    const job = run?.captionJobs?.[0];
    assert.equal(job?.status, "ready");
    assert.equal(job?.captionedUrl, CAPTIONED);
    assert.equal(job?.costUsd, 0.42);
    assert.equal(after.receipts.length, 1);
    const receipt = after.receipts[0];
    assert.equal(receipt.label, "Campaign film reel · burned captions · 45s");
    assert.equal(receipt.mediaType, "video");
    assert.equal(receipt.format, "9:16");
    assert.equal(receipt.outputUrl, CAPTIONED);
    assert.equal(receipt.derivedFromFilmRunId, "filmrun_1");
    assert.equal(receipt.sourceReelUrl, REEL);
    assert.equal(receipt.captionLanguage, "en");
    assert.equal(receipt.role, "subtitle");
    assert.equal(receipt.aspectVerdict, "match");
    assert.equal(receipt.actualWidth, 1080);
    assert.equal(receipt.actualHeight, 1920);
    assert.equal(receipt.durationSeconds, 45);
    assert.equal(receipt.actualCapability, "wizper");
    assert.equal(receipt.ual, undefined);
    assert.equal(receipt.publicationStatus, undefined);
    assert.equal(receipt.storageStatus, undefined);
    assert.equal(receipt.visibility, "private");
    assert.equal(job?.receiptId, receipt.id);
    assert.equal(JSON.stringify(after.jobs), jobsBefore);
    assert.equal((after.runs ?? []).length, 0);
  });

  it("records aspect mismatch honestly when dimensions disagree", async () => {
    const { store, read } = memoryStore(seedDb(readyRun(), "mismatch").db);
    setRunStore(store);
    const client = fakeCaption({ transcribe: [transcribed({ actualWidth: 1920, actualHeight: 1080 })] });
    const result = await submitCaptionJob({ workspaceId: WS, campaignId: "cmp_mismatch", filmRunId: "filmrun_1", language: "en" });
    assert.ok(result.job);
    await pumpCaptionJob(WS, "cmp_mismatch", "filmrun_1", result.job.id, client);
    const receipt = read().campaigns[0].receipts[0];
    assert.equal(receipt.aspectVerdict, "mismatch");
  });

  it("cost stays unavailable until the provider returns it", async () => {
    const { store, read } = memoryStore(seedDb(readyRun(), "nocost").db);
    setRunStore(store);
    const client = fakeCaption({ transcribe: [transcribed({ costUsd: undefined })] });
    const result = await submitCaptionJob({ workspaceId: WS, campaignId: "cmp_nocost", filmRunId: "filmrun_1", language: "en" });
    assert.ok(result.job);
    await pumpCaptionJob(WS, "cmp_nocost", "filmrun_1", result.job.id, client);
    const after = read().campaigns[0];
    assert.equal(after.filmRuns?.[0].captionJobs?.[0].costUsd, undefined);
    assert.equal(after.receipts[0].costUsd, undefined);
  });
});

describe("transcript-only never claims burned captions", () => {
  it("stores the transcript as metadata with no receipt", async () => {
    const { store, read } = memoryStore(seedDb(readyRun(), "tonly").db);
    setRunStore(store);
    const client = fakeCaption({ transcribe: [transcribed({ outputUrl: undefined })] });
    const result = await submitCaptionJob({ workspaceId: WS, campaignId: "cmp_tonly", filmRunId: "filmrun_1", language: "en" });
    assert.ok(result.job);
    await pumpCaptionJob(WS, "cmp_tonly", "filmrun_1", result.job.id, client);
    const after = read().campaigns[0];
    const job = after.filmRuns?.[0].captionJobs?.[0];
    assert.equal(job?.status, "failed");
    assert.equal(job?.transcriptText, "hello world");
    assert.match(job?.error ?? "", /Transcript received; captions were not burned into a video/);
    assert.equal(after.receipts.length, 0);
    assert.equal(after.filmRuns?.[0].reelUrl, REEL);
  });
});

describe("honest failures keep the reel intact", () => {
  it("empty responses fail recoverably with no receipt", async () => {
    const { store, read } = memoryStore(seedDb(readyRun(), "empty").db);
    setRunStore(store);
    const client = fakeCaption({
      transcribe: [{
        outputUrl: undefined,
        transcriptText: undefined,
        burnPending: false,
        failed: false,
        statusText: "",
        raw: {}
      }]
    });
    const result = await submitCaptionJob({ workspaceId: WS, campaignId: "cmp_empty", filmRunId: "filmrun_1", language: "en" });
    assert.ok(result.job);
    await pumpCaptionJob(WS, "cmp_empty", "filmrun_1", result.job.id, client);
    const after = read().campaigns[0];
    assert.equal(after.filmRuns?.[0].captionJobs?.[0].status, "failed");
    assert.match(after.filmRuns?.[0].captionJobs?.[0].error ?? "", /no usable output/);
    assert.equal(after.receipts.length, 0);
    assert.equal(after.filmRuns?.[0].reelUrl, REEL);
  });

  it("provider rejections fail with a static message, reel intact", async () => {
    const { store, read } = memoryStore(seedDb(readyRun(), "reject").db);
    setRunStore(store);
    const client = fakeCaption({ transcribe: [new Error("transcribe failed: quota exhausted Xe9#secret")] });
    const result = await submitCaptionJob({ workspaceId: WS, campaignId: "cmp_reject", filmRunId: "filmrun_1", language: "en" });
    assert.ok(result.job);
    await pumpCaptionJob(WS, "cmp_reject", "filmrun_1", result.job.id, client);
    const after = read().campaigns[0];
    const job = after.filmRuns?.[0].captionJobs?.[0];
    assert.equal(job?.status, "failed");
    assert.ok(!(job?.error ?? "").includes("Xe9#secret"), "raw provider text must not leak into the job error");
    assert.match(job?.error ?? "", /original reel is intact/);
    assert.equal(after.receipts.length, 0);
  });
});

describe("burn-pending parks without claiming delivery", () => {
  it("tracks the provider job without a receipt", async () => {
    const { store, read } = memoryStore(seedDb(readyRun(), "pending").db);
    setRunStore(store);
    const client = fakeCaption({
      transcribe: [{ outputUrl: undefined, burnPending: true, failed: false, statusText: "burning", providerJobId: "tjob_9", raw: {} }]
    });
    const result = await submitCaptionJob({ workspaceId: WS, campaignId: "cmp_pending", filmRunId: "filmrun_1", language: "en" });
    assert.ok(result.job);
    await pumpCaptionJob(WS, "cmp_pending", "filmrun_1", result.job.id, client);
    const job = read().campaigns[0].filmRuns?.[0].captionJobs?.[0];
    assert.equal(job?.status, "burning");
    assert.equal(job?.providerJobId, "tjob_9");
    assert.equal(read().campaigns[0].receipts.length, 0);
  });
});

describe("cancellation isolation", () => {
  it("cancels only the tracked job and preserves the reel and assets", async () => {
    const seed = seedDb(readyRun(), "cancel");
    seed.db.campaigns[0].jobs.push({ id: "job_short", status: "ready_to_share" } as never);
    seed.db.campaigns[0].receipts.push({ id: "rcpt_short" } as never);
    const jobsBefore = JSON.stringify(seed.db.campaigns[0].jobs);
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeCaption({
      transcribe: [{ outputUrl: undefined, burnPending: true, failed: false, statusText: "burning", providerJobId: "tjob_9", raw: {} }]
    });
    const result = await submitCaptionJob({ workspaceId: WS, campaignId: seed.campaignId, filmRunId: "filmrun_1", language: "en" });
    assert.ok(result.job);
    await pumpCaptionJob(WS, seed.campaignId, "filmrun_1", result.job.id, client);
    const cancelled = await cancelCaptionJob(WS, seed.campaignId, "filmrun_1", result.job.id, client);
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.providerConfirmed, true);
    assert.deepEqual(client.calls.filter((c) => c.kind === "cancel").map((c) => (c.args as { jobId: string }).jobId), ["tjob_9"]);
    const after = read().campaigns[0];
    assert.equal(after.filmRuns?.[0].captionJobs?.[0].status, "cancelled");
    assert.equal(after.filmRuns?.[0].reelUrl, REEL);
    assert.equal(JSON.stringify(after.jobs), jobsBefore);
    assert.equal(after.receipts.length, 1);
  });

  it("cancels locally with no provider call when nothing was tracked", async () => {
    const { store, read } = memoryStore(seedDb(readyRun(), "cancellocal").db);
    setRunStore(store);
    const client = fakeCaption({});
    const result = await submitCaptionJob({ workspaceId: WS, campaignId: "cmp_cancellocal", filmRunId: "filmrun_1", language: "en" });
    assert.ok(result.job);
    const cancelled = await cancelCaptionJob(WS, "cmp_cancellocal", "filmrun_1", result.job.id, client);
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.providerConfirmed, false);
    assert.equal(client.calls.length, 0);
    assert.equal(read().campaigns[0].filmRuns?.[0].captionJobs?.[0].status, "cancelled");
  });
});

describe("legacy campaigns unaffected", () => {
  it("campaigns without film runs cannot submit captions", async () => {
    const { store } = memoryStore(seedDb(null, "legacy").db);
    setRunStore(store);
    const result = await submitCaptionJob({ workspaceId: WS, campaignId: "cmp_legacy", filmRunId: "filmrun_x", language: "en" });
    assert.equal(result.created, false);
    assert.match(result.error ?? "", /Film run not found/);
  });
});

describe("transcribe parser defense", () => {
  it("never mistakes the source echo or sidecars for output", () => {
    const echo = parseTranscribeResult(
      { result: { source_url: REEL, url: REEL, status: "completed" } },
      REEL
    );
    assert.equal(echo.outputUrl, undefined);
    const sidecar = parseTranscribeResult(
      { result: { status: "completed", transcript: "hi", srt_url: "https://cdn.example/cap.srt" } },
      REEL
    );
    assert.equal(sidecar.outputUrl, undefined);
    assert.equal(sidecar.transcriptText, "hi");
    const burned = parseTranscribeResult(
      { result: { status: "completed", captioned_url: CAPTIONED, transcript: "hi", cost_usd: 0.1, duration_seconds: 45, width: 1080, height: 1920 } },
      REEL
    );
    assert.equal(burned.outputUrl, CAPTIONED);
    assert.equal(burned.costUsd, 0.1);
    assert.equal(burned.durationSeconds, 45);
    assert.equal(burned.actualWidth, 1080);
    assert.equal(burned.actualHeight, 1920);
  });

  it("garbage parses to no output and no transcript", () => {
    const parsed = parseTranscribeResult({ result: { nonsense: [1] } }, REEL);
    assert.equal(parsed.outputUrl, undefined);
    assert.equal(parsed.transcriptText, undefined);
    assert.equal(parsed.failed, false);
    assert.equal(parsed.burnPending, false);
  });
});

const STALE_AT = new Date(Date.now() - 13 * 60 * 1000).toISOString();
const FRESH_AT = new Date(Date.now() - 60 * 1000).toISOString();

function staleJob(over: Partial<FilmCaptionJob> = {}): FilmCaptionJob {
  return {
    id: "filmcap_stale",
    campaignId: "cmp_x",
    filmRunId: "filmrun_1",
    language: "en",
    sourceReelUrl: REEL,
    status: "transcribing",
    dispatchStartedAt: STALE_AT,
    attempt: 1,
    createdAt: STALE_AT,
    updatedAt: STALE_AT,
    ...over
  };
}

function seedCaptionDb(tag: string, jobs: FilmCaptionJob[]): { db: Database; campaignId: string } {
  const seed = seedDb(readyRun(), tag);
  seed.db.campaigns[0].filmRuns = [{ ...readyRun(), campaignId: seed.campaignId, captionJobs: jobs }];
  return seed;
}

describe("interrupted-claim staleness is derived, never auto-advanced", () => {
  it("stale claimed jobs display outcome-unknown without mutating the record", () => {
    const queued = staleJob({ status: "queued" });
    const transcribing = staleJob({ status: "transcribing" });
    assert.equal(isCaptionStale(queued), true);
    assert.equal(isCaptionStale(transcribing), true);
    assert.equal(captionDisplayStatus(queued), "outcome_unknown");
    assert.equal(captionDisplayStatus(transcribing), "outcome_unknown");
    assert.equal(queued.status, "queued");
    assert.equal(transcribing.status, "transcribing");
  });

  it("fresh, unclaimed, and settled jobs are never stale", () => {
    assert.equal(isCaptionStale(staleJob({ dispatchStartedAt: undefined })), false);
    assert.equal(isCaptionStale(staleJob({ dispatchStartedAt: FRESH_AT })), false);
    assert.equal(isCaptionStale(staleJob({ status: "burning", providerJobId: "tjob_1" })), false);
    assert.equal(isCaptionStale(staleJob({ status: "ready" })), false);
    assert.equal(isCaptionStale(staleJob({ status: "failed" })), false);
    assert.equal(isCaptionStale(staleJob({ status: "outcome_unknown" })), false);
    assert.equal(captionDisplayStatus(staleJob({ dispatchStartedAt: FRESH_AT })), "transcribing");
    assert.equal(captionDisplayStatus(staleJob({ status: "outcome_unknown" })), "outcome_unknown");
  });

  it("the pump never dispatches a stale claimed job", async () => {
    const { store, read } = memoryStore(seedCaptionDb("stalepump", [staleJob()]).db);
    setRunStore(store);
    const client = fakeCaption({ transcribe: [transcribed()] });
    const result = await pumpCaptionJob(WS, "cmp_stalepump", "filmrun_1", "filmcap_stale", client);
    assert.equal(result.pumped, false);
    assert.equal(result.reason, "stale-claim");
    assert.equal(client.calls.length, 0);
    const job = read().campaigns[0].filmRuns?.[0].captionJobs?.[0];
    assert.equal(job?.status, "transcribing");
    assert.equal(job?.dispatchStartedAt, STALE_AT);
  });

  it("the read-only view returns the record without dispatching or mutating", async () => {
    const { read } = memoryStore(seedCaptionDb("view", [staleJob()]).db);
    const campaign = read().campaigns[0];
    const before = JSON.stringify(campaign);
    const view = findCaptionJobView(campaign, "filmrun_1", "filmcap_stale");
    assert.ok(view);
    assert.equal(view.status, "transcribing");
    assert.equal(JSON.stringify(campaign), before);
  });
});

describe("explicit unknown-outcome recovery", () => {
  it("preserves the original and mints a distinct fresh job", async () => {
    const original = staleJob({ transcriptText: "partial hello", costUsd: 0.11 });
    const seed = seedCaptionDb("recover", [original]);
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const recovered = await recoverCaptionJob(WS, seed.campaignId, "filmrun_1", "filmcap_stale");
    if (!recovered.ok) throw new Error(`unexpected recovery failure: ${recovered.error}`);
    assert.ok(recovered.job);
    assert.equal(recovered.recoveredFrom, "filmcap_stale");
    assert.notEqual(recovered.job.id, "filmcap_stale");
    assert.equal(recovered.job.status, "queued");
    assert.equal(recovered.job.language, "en");
    assert.equal(recovered.job.sourceReelUrl, REEL);
    assert.equal(recovered.job.attempt, 1);
    assert.ok(recovered.job.idempotencyKey);
    assert.notEqual(recovered.job.idempotencyKey, original.idempotencyKey);
    const jobs = read().campaigns[0].filmRuns?.[0].captionJobs ?? [];
    assert.equal(jobs.length, 2);
    const preserved = jobs.find((j) => j.id === "filmcap_stale");
    assert.equal(preserved?.status, "outcome_unknown");
    assert.ok(preserved?.outcomeUnknownAt);
    assert.ok(preserved?.finishedAt);
    assert.equal(preserved?.error, OUTCOME_UNKNOWN_COPY);
    assert.equal(preserved?.transcriptText, "partial hello");
    assert.equal(preserved?.costUsd, 0.11);
    assert.equal(read().campaigns[0].receipts.length, 0);
    assert.equal(read().campaigns[0].filmRuns?.[0].reelUrl, REEL);
  });

  it("submits only the new job, never the preserved original", async () => {
    const seed = seedCaptionDb("recoversubmit", [staleJob()]);
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeCaption({ transcribe: [transcribed()] });
    const recovered = await recoverCaptionJob(WS, seed.campaignId, "filmrun_1", "filmcap_stale");
    if (!recovered.ok) throw new Error(`unexpected recovery failure: ${recovered.error}`);
    await pumpCaptionJob(WS, seed.campaignId, "filmrun_1", recovered.job.id, client);
    assert.equal(client.calls.filter((c) => c.kind === "transcribe").length, 1);
    const jobs = read().campaigns[0].filmRuns?.[0].captionJobs ?? [];
    assert.equal(jobs.find((j) => j.id === "filmcap_stale")?.status, "outcome_unknown");
    assert.equal(jobs.find((j) => j.id === recovered.job?.id)?.status, "ready");
    assert.equal(read().campaigns[0].receipts.length, 1);
  });

  it("refuses recovery for fresh, settled, and already-preserved jobs", async () => {
    const seed = seedCaptionDb("recoverno", [
      staleJob({ id: "filmcap_fresh", dispatchStartedAt: FRESH_AT }),
      staleJob({ id: "filmcap_failed", status: "failed", dispatchStartedAt: undefined })
    ]);
    const { store } = memoryStore(seed.db);
    setRunStore(store);
    for (const id of ["filmcap_fresh", "filmcap_failed"]) {
      const result = await recoverCaptionJob(WS, seed.campaignId, "filmrun_1", id);
      if (result.ok) throw new Error(`recovery must refuse ${id}`);
      assert.ok(result.error, id);
      assert.equal(result.conflict, false, id);
    }
    const missing = await recoverCaptionJob(WS, seed.campaignId, "filmrun_1", "filmcap_nope");
    if (missing.ok) throw new Error("recovery must refuse unknown jobs");
    assert.match(missing.error ?? "", /not found/);
  });

  it("ordinary retry stays distinct: outcome-unknown is not resumable", () => {
    assert.equal(canRetryCaptionJob(staleJob({ status: "failed", dispatchStartedAt: undefined })), null);
    assert.match(canRetryCaptionJob(staleJob({ status: "outcome_unknown" })) ?? "", /Only failed/);
    assert.match(canRetryCaptionJob(staleJob()) ?? "", /Only failed/);
    assert.match(
      canRetryCaptionJob(staleJob({ status: "failed", providerJobId: "tjob_1", dispatchStartedAt: undefined })) ?? "",
      /already reached the provider/
    );
    assert.match(captionRecoveryError(staleJob({ status: "outcome_unknown" })) ?? "", /already preserved/);
    assert.match(captionRecoveryError(staleJob({ dispatchStartedAt: FRESH_AT })) ?? "", /delivery window/);
    assert.equal(captionRecoveryError(staleJob()), null);
  });
});

describe("concurrent recovery is atomic and truthful", () => {
  it("two simultaneous recoveries: one success, one conflict, single write", async () => {
    const seed = seedCaptionDb("race", [staleJob()]);
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const [a, b] = await Promise.all([
      recoverCaptionJob(WS, seed.campaignId, "filmrun_1", "filmcap_stale"),
      recoverCaptionJob(WS, seed.campaignId, "filmrun_1", "filmcap_stale")
    ]);
    const winner = a.ok ? a : b.ok ? b : undefined;
    const loser = a.ok ? b : a;
    if (!winner?.ok) throw new Error("one recovery must succeed");
    if (loser.ok) throw new Error("the other recovery must fail");
    assert.equal(loser.conflict, true);
    assert.ok(!("job" in loser), "the loser exposes no job object");
    assert.ok(!("recoveredFrom" in loser), "the loser exposes no recovery linkage");
    const jobs = read().campaigns[0].filmRuns?.[0].captionJobs ?? [];
    assert.equal(jobs.length, 2);
    assert.equal(jobs.filter((j) => j.status === "outcome_unknown").length, 1);
    const fresh = jobs.filter((j) => j.status === "queued");
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].id, winner.job.id);
    assert.equal(
      read().events.filter((e) => e.kind === "film-caption.recover").length,
      1
    );
  });

  it("the loser cannot cause a provider dispatch", async () => {
    const seed = seedCaptionDb("racepump", [staleJob()]);
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeCaption({ transcribe: [transcribed()] });
    const [a, b] = await Promise.all([
      recoverCaptionJob(WS, seed.campaignId, "filmrun_1", "filmcap_stale"),
      recoverCaptionJob(WS, seed.campaignId, "filmrun_1", "filmcap_stale")
    ]);
    const winner = a.ok ? a : b;
    if (!winner.ok) throw new Error("one recovery must succeed");
    // Only the persisted winner id is pumpable: one provider call.
    await pumpCaptionJob(WS, seed.campaignId, "filmrun_1", winner.job.id, client);
    assert.equal(client.calls.filter((c) => c.kind === "transcribe").length, 1);
    // The preserved original is settled: pumping it dispatches nothing.
    await pumpCaptionJob(WS, seed.campaignId, "filmrun_1", "filmcap_stale", client);
    assert.equal(client.calls.filter((c) => c.kind === "transcribe").length, 1);
    assert.equal(read().campaigns[0].filmRuns?.[0].captionJobs?.find((j) => j.id === "filmcap_stale")?.status, "outcome_unknown");
  });

  it("route outcome mapping answers 409 with the exact stable message", () => {
    assert.deepEqual(recoverHttpOutcome({ ok: false, error: "changed mid-flight", conflict: true }), {
      status: 409,
      body: { error: RECOVERY_CONFLICT_MESSAGE }
    });
    assert.equal(
      RECOVERY_CONFLICT_MESSAGE,
      "This caption request was already recovered or changed. Refresh once to see its current status."
    );
    const ok = recoverHttpOutcome({ ok: true, job: staleJob({ id: "filmcap_new", status: "queued" }), recoveredFrom: "filmcap_stale" });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { ok: true, captionJobId: "filmcap_new", recoveredFrom: "filmcap_stale" });
    const bad = recoverHttpOutcome({ ok: false, error: "still fresh", conflict: false });
    assert.deepEqual(bad, { status: 400, body: { error: "still fresh" } });
  });
});
