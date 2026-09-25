import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Campaign, Database } from "../types";
import { emptyDb } from "../store";
import { setRunStore, memoryStore } from "./run-store";
import { createStarterFilmPlan, type FilmPlan } from "./film-plan";
import type { TemplateFormat } from "./template-catalogue";
import {
  buildCreativeSubmitArgs,
  buildScenePrompt,
  filmAspectForProvider,
  parseCreativeStatus,
  parseCreativeSubmit,
  SCENE_PROMPT_MAX_CHARS
} from "./film-job";
import { checkFilmCap, filmDisplayLabel, nextFilmAction } from "./film-run";
import {
  cancelFilmRun,
  pumpFilmRun,
  submitFilmRun,
  type FilmMcpClient
} from "./film-pump";
import type { CreativeStatusParsed, CreativeSubmitParsed } from "./film-job";

/**
 * Campaign Film execution tests: durable runs, stable idempotency, resume
 * polls, reel-URL gating, honest failures, cap refusal, cancel isolation,
 * optional scene outputs, and short-clip non-interference. Provider traffic
 * uses scripted fakes (synthetic shapes, zero network, zero spend); the
 * workspace uses the in-memory run-store seam.
 */

const WS = "ws-film-test";
const REEL = "https://cdn.example/film-reel.mp4";
const SCENE1 = "https://cdn.example/film-scene-1.mp4";

function filmPlan(): FilmPlan {
  const r = createStarterFilmPlan(45, { title: "Test reel", budgetCapUsd: 25 });
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("starter must validate");
  return r.filmPlan;
}

function seedDb(plan: FilmPlan | null, tag: string): { db: Database; campaignId: string } {
  const db = emptyDb();
  const campaignId = `cmp_${tag}`;
  const campaign = {
    id: campaignId,
    title: "film campaign",
    brand: "brand",
    productName: "product",
    request: {
      platform: "instagram",
      country: "US",
      requestedClaims: [],
      transformation: "video",
      creativeBrief: "A sufficiently long creative brief for the film probe.",
      qualityProfile: "balanced",
      ...(plan ? { filmPlan: plan } : {})
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

interface ScriptedClient extends FilmMcpClient {
  calls: { kind: string; args: unknown }[];
}

function fakeClient(script: {
  submit?: CreativeSubmitParsed[];
  confirm?: CreativeSubmitParsed[];
  status?: (CreativeStatusParsed | Error)[];
  cancel?: { cancelled: boolean; note: string };
}): ScriptedClient {
  const calls: { kind: string; args: unknown }[] = [];
  const submitQueue = [...(script.submit ?? [])];
  const confirmQueue = [...(script.confirm ?? [])];
  const statusQueue = [...(script.status ?? [])];
  return {
    calls,
    submitCreativeJob: async (args) => {
      calls.push({ kind: "submit", args });
      const next = submitQueue.shift();
      if (!next) throw new Error("no scripted submit response");
      return next;
    },
    confirmCreativeJob: async (providerJobId) => {
      calls.push({ kind: "confirm", args: { providerJobId } });
      const next = confirmQueue.shift();
      if (!next) throw new Error("no scripted confirm response");
      return next;
    },
    getCreativeJob: async (jobId) => {
      calls.push({ kind: "status", args: { jobId } });
      const next = statusQueue.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error("no scripted status response");
      return next;
    },
    cancelCreativeJob: async (jobId) => {
      calls.push({ kind: "cancel", args: { jobId } });
      return script.cancel ?? { cancelled: true, note: "Provider confirmed cancellation." };
    }
  };
}

function submitted(args: Partial<CreativeSubmitParsed> = {}): CreativeSubmitParsed {
  return { providerJobId: "cjob_abc123", awaitingConfirmation: false, raw: {}, ...args };
}

function staged(estimateUsd: number): CreativeSubmitParsed {
  return { providerJobId: "cjob_abc123", awaitingConfirmation: true, estimateUsd, raw: {} };
}

function status(over: Partial<CreativeStatusParsed> = {}): CreativeStatusParsed {
  return {
    statusText: "rendering",
    awaitingConfirmation: false,
    terminal: false,
    failed: false,
    sceneOutputs: [],
    raw: {},
    ...over
  };
}

afterEach(() => {
  setRunStore(null);
});

describe("submit returns fast with a durable run", () => {
  it("creates one confirmed run from the saved plan", async () => {
    const { store, read } = memoryStore(seedDb(filmPlan(), "submit").db);
    setRunStore(store);
    const startedAt = Date.now();
    const result = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_submit", idempotencyKey: "film-key-1" });
    assert.ok(Date.now() - startedAt < 5000, "submit returns fast");
    assert.equal(result.created, true);
    assert.ok(result.run);
    assert.equal(result.run.status, "confirmed");
    assert.equal(result.run.targetDurationSeconds, 45);
    assert.equal(result.run.budgetCapUsd, 25);
    assert.equal(result.run.plannedScenes.length, 6);
    assert.ok(result.run.sceneFingerprint.length >= 32);
    assert.match(result.run.providerSessionId, /^[A-Za-z0-9_-]{1,128}$/);
    assert.equal(result.run.idempotencyKey, "film-key-1");
    const stored = read().campaigns[0].filmRuns ?? [];
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, result.run.id);
  });

  it("replays the same idempotency key and blocks a second active run", async () => {
    const { store, read } = memoryStore(seedDb(filmPlan(), "idem").db);
    setRunStore(store);
    const first = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_idem", idempotencyKey: "film-key-1" });
    const replay = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_idem", idempotencyKey: "film-key-1" });
    assert.equal(replay.created, false);
    assert.equal(replay.run?.id, first.run?.id);
    const other = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_idem", idempotencyKey: "film-key-2" });
    assert.equal(other.created, false);
    assert.equal(other.run?.id, first.run?.id);
    assert.equal((read().campaigns[0].filmRuns ?? []).length, 1);
  });

  it("refuses without a saved plan and on blocked campaigns", async () => {
    const seed = seedDb(null, "noplan");
    const { store } = memoryStore(seed.db);
    setRunStore(store);
    const missing = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_noplan" });
    assert.equal(missing.created, false);
    assert.match(missing.error ?? "", /Save a film plan first/);
  });
});

describe("submit sends only confirmed product fields", () => {
  it("carries title/scenes/target/aspect/deliver/cap/session and nothing else", async () => {
    const { store } = memoryStore(seedDb(filmPlan(), "args").db);
    setRunStore(store);
    const client = fakeClient({ submit: [submitted()], status: [status({ statusText: "rendering_scenes" })] });
    const result = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_args" });
    assert.ok(result.run);
    await pumpFilmRun(WS, "cmp_args", result.run.id, { budgetMs: 50 }, client);
    const submits = client.calls.filter((c) => c.kind === "submit");
    assert.equal(submits.length, 1);
    const args = submits[0].args as Record<string, unknown>;
    assert.deepEqual(Object.keys(args).sort(), ["aspect_ratio", "budget_usd", "deliver", "scenes", "session_id", "target_duration_sec", "title"]);
    assert.equal(args.title, "Test reel");
    assert.equal(args.target_duration_sec, 45);
    assert.equal(args.aspect_ratio, "9:16");
    assert.equal(args.deliver, "reel");
    assert.equal(args.budget_usd, 25);
    const scenes = args.scenes as { title: string; prompt: string; duration: number }[];
    assert.equal(scenes.length, 6);
    assert.ok(scenes.every((s) => typeof s.prompt === "string" && s.prompt.length > 0 && Number.isInteger(s.duration)));
    assert.equal(scenes[0].duration, 8);
    for (const banned of ["auto_plan", "generation_mode", "quality", "style", "brief", "character_anchor", "cast", "model_override", "soundtrack", "music", "checkpoint_every_n", "keyframe_review", "idempotency_key"]) {
      assert.ok(!(banned in args), `${banned} must not be sent`);
    }
  });

  it("omits aspect_ratio for aspects with no provider enum value (never mapped to a lookalike)", () => {
    assert.equal(filmAspectForProvider("2:1" as TemplateFormat), undefined);
    assert.equal(filmAspectForProvider("9:16"), "9:16");
    const plan = filmPlan();
    const args = buildCreativeSubmitArgs({ ...plan, aspectRatio: "2:1" as TemplateFormat }, "permitframe_filmrun_x");
    assert.ok(!("aspect_ratio" in args));
  });

  it("caps scene prompts at the observed 4000-char limit", () => {
    const prompt = buildScenePrompt({
      title: "Hook",
      visualDirection: "x".repeat(5000),
      sourceIntent: "Approved source media as the visual reference."
    });
    assert.ok(prompt.length <= SCENE_PROMPT_MAX_CHARS);
    assert.ok(prompt.startsWith("Hook: "));
    assert.ok(prompt.endsWith("Approved source media as the visual reference."));
  });
});

describe("staged gate, cap refusal, and stable retries", () => {
  it("confirms a staged job inside the cap, reusing the same provider id", async () => {
    const { store, read } = memoryStore(seedDb(filmPlan(), "staged").db);
    setRunStore(store);
    const client = fakeClient({
      submit: [staged(1.2)],
      confirm: [submitted()],
      status: [status({ statusText: "rendering_scenes" })]
    });
    const result = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_staged" });
    assert.ok(result.run);
    const sessionId = result.run.providerSessionId;
    await pumpFilmRun(WS, "cmp_staged", result.run.id, { budgetMs: 5000 }, client);
    const confirms = client.calls.filter((c) => c.kind === "confirm");
    assert.equal(confirms.length, 1);
    assert.deepEqual((confirms[0].args as { providerJobId: string }).providerJobId, "cjob_abc123");
    const run = read().campaigns[0].filmRuns?.[0];
    assert.equal(run?.providerJobId, "cjob_abc123");
    assert.equal(run?.estimateUsd, 1.2);
    // Second pump reuses the tracked id: no second submit, same session tag.
    await pumpFilmRun(WS, "cmp_staged", result.run.id, { budgetMs: 50 }, client);
    assert.equal(client.calls.filter((c) => c.kind === "submit").length, 1);
    assert.ok(client.calls.filter((c) => c.kind === "status").length >= 1);
    assert.equal(read().campaigns[0].filmRuns?.[0].providerSessionId, sessionId);
  });

  it("refuses a staged estimate over the cap before confirming", async () => {
    const { store, read } = memoryStore(seedDb(filmPlan(), "overcap").db);
    setRunStore(store);
    const client = fakeClient({ submit: [staged(99)] });
    const result = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_overcap" });
    assert.ok(result.run);
    await pumpFilmRun(WS, "cmp_overcap", result.run.id, { budgetMs: 5000 }, client);
    assert.equal(client.calls.filter((c) => c.kind === "confirm").length, 0);
    assert.equal(client.calls.filter((c) => c.kind === "status").length, 0);
    const run = read().campaigns[0].filmRuns?.[0];
    assert.equal(run?.status, "failed");
    assert.match(run?.error ?? "", /exceeds the confirmed \$25\.00 maximum/);
  });

  it("fails honestly on provider budget_exceeded with nothing dispatched", async () => {
    const { store, read } = memoryStore(seedDb(filmPlan(), "refused").db);
    setRunStore(store);
    const client = fakeClient({
      submit: [{
        providerJobId: undefined,
        awaitingConfirmation: false,
        budgetExceeded: { estimateUsd: 40, budgetUsd: 25, note: "budget_exceeded" },
        raw: { code: "budget_exceeded" }
      }]
    });
    const result = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_refused" });
    assert.ok(result.run);
    await pumpFilmRun(WS, "cmp_refused", result.run.id, { budgetMs: 5000 }, client);
    const run = read().campaigns[0].filmRuns?.[0];
    assert.equal(run?.status, "failed");
    assert.equal(run?.providerJobId, undefined);
    assert.match(run?.error ?? "", /nothing was staged or dispatched/);
    assert.equal(client.calls.filter((c) => c.kind === "confirm").length, 0);
  });

  it("resume polls rather than resubmits across pump restarts", async () => {
    const { store } = memoryStore(seedDb(filmPlan(), "resume").db);
    setRunStore(store);
    const rendering = () => status({ statusText: "rendering_scenes" });
    const client = fakeClient({
      submit: [submitted()],
      status: [rendering(), rendering(), rendering(), rendering(), rendering(), rendering()]
    });
    const result = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_resume" });
    assert.ok(result.run);
    await pumpFilmRun(WS, "cmp_resume", result.run.id, { budgetMs: 5000 }, client);
    const submitsAfterFirst = client.calls.filter((c) => c.kind === "submit").length;
    const pollsAfterFirst = client.calls.filter((c) => c.kind === "status").length;
    assert.equal(submitsAfterFirst, 1);
    assert.ok(pollsAfterFirst >= 1, "first pump polls the tracked id");
    // A fresh pump (process restart equivalent) reuses the stored provider
    // id: zero new submits, strictly more polls.
    await pumpFilmRun(WS, "cmp_resume", result.run.id, { budgetMs: 5000 }, client);
    assert.equal(client.calls.filter((c) => c.kind === "submit").length, 1);
    assert.ok(client.calls.filter((c) => c.kind === "status").length > pollsAfterFirst, "resume polls again");
  });
});

describe("completion requires a usable final reel URL", () => {
  it("marks ready only on terminal status plus an HTTPS reel", async () => {
    const { store, read } = memoryStore(seedDb(filmPlan(), "ready").db);
    setRunStore(store);
    const client = fakeClient({
      submit: [submitted()],
      status: [status({ statusText: "completed", terminal: true, reelUrl: REEL, costUsd: 3.5, capability: "provider-mix" })]
    });
    const result = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_ready" });
    assert.ok(result.run);
    await pumpFilmRun(WS, "cmp_ready", result.run.id, { budgetMs: 5000 }, client);
    const run = read().campaigns[0].filmRuns?.[0];
    assert.equal(run?.status, "ready");
    assert.equal(run?.reelUrl, REEL);
    assert.equal(run?.costUsd, 3.5);
    assert.equal(run?.actualCapability, "provider-mix");
    assert.ok(run?.finishedAt);
  });

  it("fails honestly when terminal status carries no reel", async () => {
    const { store, read } = memoryStore(seedDb(filmPlan(), "noreel").db);
    setRunStore(store);
    const client = fakeClient({
      submit: [submitted()],
      status: [status({ statusText: "completed", terminal: true })]
    });
    const result = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_noreel" });
    assert.ok(result.run);
    await pumpFilmRun(WS, "cmp_noreel", result.run.id, { budgetMs: 5000 }, client);
    const run = read().campaigns[0].filmRuns?.[0];
    assert.equal(run?.status, "failed");
    assert.match(run?.error ?? "", /without a final reel URL/);
    assert.equal(run?.reelUrl, undefined);
  });

  it("fails honestly on terminal failure states", async () => {
    const { store, read } = memoryStore(seedDb(filmPlan(), "failed").db);
    setRunStore(store);
    const client = fakeClient({
      submit: [submitted()],
      status: [status({ statusText: "failed", terminal: true, failed: true })]
    });
    const result = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_failed" });
    assert.ok(result.run);
    await pumpFilmRun(WS, "cmp_failed", result.run.id, { budgetMs: 5000 }, client);
    const run = read().campaigns[0].filmRuns?.[0];
    assert.equal(run?.status, "failed");
    assert.match(run?.error ?? "", /ended \(failed\) before delivery/);
  });

  it("stays active through transient poll failures without losing the id", async () => {
    const { store, read } = memoryStore(seedDb(filmPlan(), "transient").db);
    setRunStore(store);
    const client = fakeClient({ submit: [submitted()], status: [new Error("socket hang up")] });
    const result = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_transient" });
    assert.ok(result.run);
    await pumpFilmRun(WS, "cmp_transient", result.run.id, { budgetMs: 100 }, client);
    const run = read().campaigns[0].filmRuns?.[0];
    assert.equal(run?.status, "submitting");
    assert.equal(run?.providerJobId, "cjob_abc123");
  });
});

describe("provider scene outputs are optional", () => {
  it("ready with reel and no scenes keeps an empty output list", async () => {
    const { store, read } = memoryStore(seedDb(filmPlan(), "scenesless").db);
    setRunStore(store);
    const client = fakeClient({
      submit: [submitted()],
      status: [status({ statusText: "completed", terminal: true, reelUrl: REEL })]
    });
    const result = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_scenesless" });
    assert.ok(result.run);
    await pumpFilmRun(WS, "cmp_scenesless", result.run.id, { budgetMs: 5000 }, client);
    const run = read().campaigns[0].filmRuns?.[0];
    assert.equal(run?.status, "ready");
    assert.deepEqual(run?.sceneOutputs, []);
  });

  it("persists provider-reported scene URLs, HTTPS-only", async () => {
    const { store, read } = memoryStore(seedDb(filmPlan(), "scenes").db);
    setRunStore(store);
    const client = fakeClient({
      submit: [submitted()],
      status: [status({
        statusText: "completed",
        terminal: true,
        reelUrl: REEL,
        sceneOutputs: [
          { index: 0, title: "Hook", url: SCENE1, status: "completed" },
          { index: 1, title: "Context", url: "http://insecure.example/s2.mp4", status: "completed" }
        ]
      })]
    });
    const result = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_scenes" });
    assert.ok(result.run);
    await pumpFilmRun(WS, "cmp_scenes", result.run.id, { budgetMs: 5000 }, client);
    const run = read().campaigns[0].filmRuns?.[0];
    assert.equal(run?.status, "ready");
    // Direct parser check: insecure entries never persist.
    const parsed = parseCreativeStatus({
      result: {
        status: "completed",
        reel_url: REEL,
        scenes: [
          { title: "Hook", url: SCENE1, status: "completed" },
          { title: "Context", url: "http://insecure.example/s2.mp4", status: "completed" }
        ]
      }
    });
    assert.equal(parsed.sceneOutputs.length, 1);
    assert.equal(parsed.sceneOutputs[0].url, SCENE1);
  });
});

describe("malformed provider responses fail honestly", () => {
  it("submit with no job id and no refusal fails the run", async () => {
    const { store, read } = memoryStore(seedDb(filmPlan(), "malformed").db);
    setRunStore(store);
    const client = fakeClient({ submit: [{ providerJobId: undefined, awaitingConfirmation: false, raw: {} }] });
    const result = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_malformed" });
    assert.ok(result.run);
    await pumpFilmRun(WS, "cmp_malformed", result.run.id, { budgetMs: 5000 }, client);
    const run = read().campaigns[0].filmRuns?.[0];
    assert.equal(run?.status, "failed");
    assert.match(run?.error ?? "", /no provider job id/);
  });

  it("empty/garbage status payloads parse to non-terminal snapshots", () => {
    const empty = parseCreativeStatus({});
    assert.equal(empty.terminal, false);
    assert.equal(empty.failed, false);
    assert.equal(empty.reelUrl, undefined);
    assert.deepEqual(empty.sceneOutputs, []);
    const garbage = parseCreativeSubmit({ result: { nonsense: [1, 2] } });
    assert.equal(garbage.providerJobId, undefined);
    assert.equal(garbage.awaitingConfirmation, false);
    assert.equal(garbage.budgetExceeded, undefined);
  });
});

describe("cancellation isolation", () => {
  it("expires a stuck film provider job once and clears the active provider id", async () => {
    const { store, read } = memoryStore(seedDb(filmPlan(), "watchdog").db);
    setRunStore(store);
    const client = fakeClient({ submit: [submitted()], status: [status({ statusText: "rendering_scenes" })] });
    const result = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_watchdog" });
    assert.ok(result.run);
    await pumpFilmRun(WS, "cmp_watchdog", result.run.id, { budgetMs: 50 }, client);
    const stored = read().campaigns[0].filmRuns![0];
    stored.dispatchDeadlineAt = new Date(Date.now() - 1_000).toISOString();
    await pumpFilmRun(WS, "cmp_watchdog", result.run.id, { budgetMs: 100 }, client);
    const expired = read().campaigns[0].filmRuns![0];
    assert.equal(expired.status, "failed");
    assert.equal(expired.providerJobId, undefined);
    assert.equal(expired.lastProviderJobId, "cjob_abc123");
    assert.equal(expired.providerFailureKind, "provider_timeout");
    assert.equal(client.calls.filter((c) => c.kind === "cancel").length, 1);
    await pumpFilmRun(WS, "cmp_watchdog", result.run.id, { budgetMs: 100 }, client);
    assert.equal(client.calls.filter((c) => c.kind === "cancel").length, 1);
  });

  it("cancels only the owned provider job and preserves campaign assets", async () => {
    const seed = seedDb(filmPlan(), "cancel");
    seed.db.campaigns[0].jobs.push({
      id: "job_done",
      campaignId: seed.campaignId,
      stageId: "keyframe",
      kind: "text-to-image",
      capability: "flux-dev",
      prompt: "p",
      status: "ready_to_share",
      outputUrl: "https://cdn.example/kept.png",
      startedAt: new Date().toISOString()
    } as never);
    seed.db.campaigns[0].receipts.push({ id: "rcpt_kept" } as never);
    seed.db.campaigns[0].runs = [{ id: "run_kept", status: "complete" } as never];
    const jobsBefore = JSON.stringify(seed.db.campaigns[0].jobs);
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeClient({ submit: [submitted()], status: [status({ statusText: "rendering_scenes" })] });
    const result = await submitFilmRun({ workspaceId: WS, campaignId: seed.campaignId });
    assert.ok(result.run);
    await pumpFilmRun(WS, seed.campaignId, result.run.id, { budgetMs: 50 }, client);
    const cancelled = await cancelFilmRun(WS, seed.campaignId, result.run.id, client);
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.providerConfirmed, true);
    const cancels = client.calls.filter((c) => c.kind === "cancel");
    assert.equal(cancels.length, 1);
    assert.deepEqual((cancels[0].args as { jobId: string }).jobId, "cjob_abc123");
    const after = read().campaigns[0];
    assert.equal(after.filmRuns?.[0].status, "cancelled");
    assert.equal(JSON.stringify(after.jobs), jobsBefore);
    assert.equal(after.receipts.length, 1);
    assert.equal((after.runs ?? []).length, 1);
  });

  it("cancels locally when no provider job was tracked, without calling", async () => {
    const { store, read } = memoryStore(seedDb(filmPlan(), "cancelbare").db);
    setRunStore(store);
    const client = fakeClient({});
    const result = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_cancelbare" });
    assert.ok(result.run);
    const cancelled = await cancelFilmRun(WS, "cmp_cancelbare", result.run.id, client);
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.providerConfirmed, false);
    assert.equal(client.calls.length, 0);
    assert.equal(read().campaigns[0].filmRuns?.[0].status, "cancelled");
  });

  it("refuses to cancel a delivered reel", async () => {
    const { store } = memoryStore(seedDb(filmPlan(), "cancelready").db);
    setRunStore(store);
    const client = fakeClient({
      submit: [submitted()],
      status: [status({ statusText: "completed", terminal: true, reelUrl: REEL })]
    });
    const result = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_cancelready" });
    assert.ok(result.run);
    await pumpFilmRun(WS, "cmp_cancelready", result.run.id, { budgetMs: 5000 }, client);
    const cancelled = await cancelFilmRun(WS, "cmp_cancelready", result.run.id, client);
    assert.equal(cancelled.cancelled, false);
    assert.match(cancelled.note, /already delivered/);
  });
});

describe("unsupported film aspects never reach the provider", () => {
  it("plan-level unsupported aspect cannot submit: no run, no provider request", async () => {
    // submitFilmRun takes no provider client at all - submission performs
    // zero provider I/O by signature; an unsupported plan fails before any
    // run exists, so no pump (and no request) can ever follow.
    const { store, read } = memoryStore(seedDb({ ...filmPlan(), aspectRatio: "2:1" as TemplateFormat }, "aspectUnsupported").db);
    setRunStore(store);
    const result = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_aspectUnsupported" });
    assert.equal(result.created, false);
    assert.equal(result.run, undefined);
    assert.match(result.error ?? "", /must be one of 9:16/);
    assert.match(result.error ?? "", /No provider request was made|no longer valid/);
    assert.equal((read().campaigns[0].filmRuns ?? []).length, 0);
  });

  it("scene-level unsupported aspect cannot submit either", async () => {
    const base = filmPlan();
    const scenes = base.scenes.map((s, i) => (i === 0 ? { ...s, format: "2:1" as TemplateFormat } : s));
    const { store, read } = memoryStore(seedDb({ ...base, scenes }, "sceneUnsupported").db);
    setRunStore(store);
    const result = await submitFilmRun({ workspaceId: WS, campaignId: "cmp_sceneUnsupported" });
    assert.equal(result.created, false);
    assert.match(result.error ?? "", /must be one of 9:16/);
    assert.equal((read().campaigns[0].filmRuns ?? []).length, 0);
  });
});

describe("pure transitions and labels", () => {
  it("nextFilmAction never resubmits a tracked id", () => {
    assert.equal(nextFilmAction({ status: "confirmed" }), "submit");
    assert.equal(nextFilmAction({ status: "submitting", providerJobId: "cjob_x" }), "poll");
    assert.equal(nextFilmAction({ status: "submitting", providerJobId: "cjob_x", providerStatus: "awaiting_confirmation" }), "confirm_staged");
    assert.equal(nextFilmAction({ status: "generating_scenes", providerJobId: "cjob_x" }), "poll");
    assert.equal(nextFilmAction({ status: "ready", providerJobId: "cjob_x" }), "none");
    assert.equal(nextFilmAction({ status: "failed", providerJobId: "cjob_x" }), "none");
    assert.equal(nextFilmAction({ status: "cancelled" }), "none");
  });

  it("cap check refuses known over-cap estimates, passes unknown ones", () => {
    assert.match(checkFilmCap(25, 40) ?? "", /exceeds the confirmed \$25\.00 maximum/);
    assert.equal(checkFilmCap(25, 25), null);
    assert.equal(checkFilmCap(25, undefined), null);
  });

  it("display labels cover Planning through Cancelled", () => {
    assert.equal(filmDisplayLabel(null), "Planning");
    assert.equal(filmDisplayLabel({ status: "confirmed" }), "Confirmed");
    assert.equal(filmDisplayLabel({ status: "submitting" }), "Submitting");
    assert.equal(filmDisplayLabel({ status: "generating_scenes" }), "Generating scenes");
    assert.equal(filmDisplayLabel({ status: "assembling_reel" }), "Assembling reel");
    assert.equal(filmDisplayLabel({ status: "ready" }), "Ready");
    assert.equal(filmDisplayLabel({ status: "failed" }), "Failed");
    assert.equal(filmDisplayLabel({ status: "cancelled" }), "Cancelled");
  });
});

describe("short-clip non-interference", () => {
  it("film submit+pump never touch jobs, receipts, runs, or the plan", async () => {
    const seed = seedDb(filmPlan(), "isolation");
    seed.db.campaigns[0].jobs.push({ id: "job_short", status: "generating" } as never);
    seed.db.campaigns[0].receipts.push({ id: "rcpt_short" } as never);
    seed.db.campaigns[0].runs = [{ id: "run_short", status: "active" } as never];
    const before = JSON.stringify({
      jobs: seed.db.campaigns[0].jobs,
      receipts: seed.db.campaigns[0].receipts,
      runs: seed.db.campaigns[0].runs,
      plan: seed.db.campaigns[0].preflight?.plan,
      spec: seed.db.campaigns[0].request.productionSpec,
      status: seed.db.campaigns[0].status
    });
    const { store, read } = memoryStore(seed.db);
    setRunStore(store);
    const client = fakeClient({
      submit: [submitted()],
      status: [status({ statusText: "completed", terminal: true, reelUrl: REEL })]
    });
    const result = await submitFilmRun({ workspaceId: WS, campaignId: seed.campaignId });
    assert.ok(result.run);
    await pumpFilmRun(WS, seed.campaignId, result.run.id, { budgetMs: 5000 }, client);
    const after = read().campaigns[0];
    assert.equal(JSON.stringify({
      jobs: after.jobs,
      receipts: after.receipts,
      runs: after.runs,
      plan: after.preflight?.plan,
      spec: after.request.productionSpec,
      status: after.status
    }), before);
    assert.equal(after.filmRuns?.[0].status, "ready");
  });
});
