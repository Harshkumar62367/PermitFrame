import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Campaign, Database, DerivativeReceipt, ProductionJob, ProductionStagePlan } from "../types";
import { emptyDb } from "../store";
import { setRunStore, memoryStore } from "./run-store";
import { pumpRun, submitRun } from "./runner";
import { FIDELITY_REFUSAL } from "./preservation-policy";
import { evaluateFidelityCheck } from "./run-finalize";
import { buildReceipt } from "./pipeline";
import { checkApprovalEligibility } from "../campaign-lifecycle";
import type { AuthorizationRevalidation } from "../policy/authorization";
import type { PermissionPassport } from "../types";
import { getTemplate, DEFERRED_MOTION_REASON, type TemplateStageRecipe } from "./template-catalogue";
import { toPlanStages } from "./template-plan-builder";

/**
 * Source-fidelity generation safety, end to end with mocked fetch
 * (synthetic HTTPS URLs, zero network, zero spend):
 * - strict stages attempt place_subject and NEVER call generic
 *   create_media after it fails (inline empty, async terminal failure);
 * - a failed post-render identity check blocks delivery and approval;
 * - a passed check earns the preserved claim with no block;
 * - legacy guided behavior and recipe defaults are unchanged.
 */

const SOURCE = "https://source.example/approved-product.png";
const PLACED_OUT = "https://cdn.example/placed-packshot.png";
const GUIDED_OUT = "https://cdn.example/guided-fallback.png";
const IMAGE_CAP = "flux-dev";
const MOTION_CAP = "kling-v3-turbo-i2v";
const HERO_OUT = "https://cdn.example/hero-916.png";

let placeMode: "empty" | "inline" | "async-fail" = "empty";
let critiqueScore: number | null = 0.95;

function strictStage(): ProductionStagePlan {
  return {
    id: "packshot",
    kind: "image-to-image",
    capability: IMAGE_CAP,
    label: "Clean packshot (1:1)",
    format: "1:1",
    dependsOnStageIds: [],
    inputSource: "approved-source",
    qualityProfile: "balanced",
    role: "productPackshot",
    fidelity: "product-preserving"
  };
}

function mkJob(): ProductionJob {
  return {
    id: "job_pack",
    campaignId: "cmp_fidelity",
    stageId: "packshot",
    kind: "image-to-image",
    capability: IMAGE_CAP,
    requestedCapability: IMAGE_CAP,
    qualityProfile: "balanced",
    role: "productPackshot",
    prompt: "clean studio packshot, preserve shape and marks exactly",
    status: "queued",
    startedAt: new Date().toISOString()
  } as ProductionJob;
}

function seedDb(): Database {
  const db = emptyDb();
  db.sourceMedia.push({ id: "m1", creatorId: "c1", title: "approved product reference", type: "image", url: SOURCE, hash: "hash" });
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
    id: "cmp_fidelity",
    title: "fidelity pack",
    brand: "brand",
    productName: "product",
    request: {
      platform: "instagram",
      country: "GR",
      requestedClaims: [],
      transformation: "image",
      creativeBrief: "A sufficiently long creative brief for the fidelity probe.",
      qualityProfile: "balanced"
    },
    status: "generating",
    preflight: {
      decision: "allow",
      checkedAt: new Date().toISOString(),
      blockers: [],
      allowedClaims: [],
      promptConstraints: ["Be honest."],
      plan: [strictStage()],
      queriedRights: [],
      queriedFacts: [],
      sparqlPreview: ""
    },
    jobs: [mkJob()],
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
    const ok = (structured: Record<string, unknown>) => ({
      result: { structuredContent: structured, content: [] },
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
      return send(ok({
        total: 2,
        capabilities: [
          { name: IMAGE_CAP, kind: "ai", availability: "available", model_id: "", description: "" },
          { name: MOTION_CAP, kind: "ai", availability: "available", model_id: "", description: "" }
        ]
      }));
    }
    if (tool === "get_pricing") return send(ok({ capabilities: [] }));
    seen.push({ tool, args });
    if (tool === "critique_shot") {
      return send(ok(critiqueScore === null ? { note: "unparseable" } : { score: critiqueScore }));
    }
    if (tool === "place_subject") {
      if (placeMode === "inline") return send(ok({ url: PLACED_OUT, status: "completed", cost_paid_usd: 0.06 }));
      if (placeMode === "async-fail") return send(ok({ job_id: "mjob_place_1", status: "queued" }));
      return send(ok({ note: "rejected" }));
    }
    if (tool === "create_media") {
      return send(ok({ job_id: "mjob_media_1", status: "queued" }));
    }
    if (tool === "get_create_media" || tool === "subscribe_progress") {
      const id = String(args.job_id ?? args.jobId ?? "");
      if (id === "mjob_place_1") return send(ok({ job_id: id, status: "failed" }));
      return send(ok({ job_id: id, status: "completed", url: GUIDED_OUT, cost_paid_usd: 0.05 }));
    }
    return send(ok({}));
  }) as typeof fetch;
}

function placeCalls(): Record<string, unknown>[] {
  return seen.filter((s) => s.tool === "place_subject").map((s) => s.args);
}

function mediaCalls(): Record<string, unknown>[] {
  return seen.filter((s) => s.tool === "create_media").map((s) => s.args);
}

function critiqueCalls(): Record<string, unknown>[] {
  return seen.filter((s) => s.tool === "critique_shot").map((s) => s.args);
}

const savedEnv: Record<string, string | undefined> = {};

async function awaitSettled(read: () => Database, timeoutMs = 25000): Promise<Campaign> {
  const start = Date.now();
  for (;;) {
    const campaign = read().campaigns.find((c) => c.id === "cmp_fidelity")!;
    const jobs = campaign.jobs;
    if (jobs.every((j) => j.status !== "queued" && j.status !== "generating")) return campaign;
    if (Date.now() - start > timeoutMs) throw new Error("fidelity jobs did not settle");
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function awaitReceipts(read: () => Database, timeoutMs = 25000): Promise<Campaign> {
  const start = Date.now();
  for (;;) {
    const campaign = read().campaigns.find((c) => c.id === "cmp_fidelity")!;
    if (campaign.receipts.length > 0) return campaign;
    if (Date.now() - start > timeoutMs) throw new Error("fidelity receipt never persisted");
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe("strict-fidelity dispatch (no generic substitute)", () => {
  before(() => {
    for (const k of ["DKG_MODE", "LIVEPEER_QUALITY_CHECK", "LIVEPEER_PLACE_SUBJECT", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.DKG_MODE = "__unsupported_test__";
    process.env.LIVEPEER_QUALITY_CHECK = "off";
    delete process.env.LIVEPEER_PLACE_SUBJECT;
    delete process.env.CLOUDINARY_CLOUD_NAME;
    delete process.env.CLOUDINARY_API_KEY;
    delete process.env.CLOUDINARY_API_SECRET;
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

  async function runPack() {
    const { store, read } = memoryStore(seedDb());
    setRunStore(store);
    seen = [];
    const submitted = await submitRun({ campaignId: "cmp_fidelity", workspaceId: "ws1" });
    assert.equal(submitted.created, true);
    await pumpRun("ws1", "cmp_fidelity", { budgetMs: 30000 });
    return { read };
  }

  it("a failed place_subject never triggers generic create_media", async () => {
    placeMode = "empty";
    critiqueScore = 0.95;
    const { read } = await runPack();
    const campaign = await awaitSettled(read);
    assert.equal(placeCalls().length, 1, "exactly one preservation attempt");
    assert.equal(mediaCalls().length, 0, "no generic substitute after place_subject failed");
    const job = campaign.jobs.find((j) => j.id === "job_pack")!;
    assert.equal(job.status, "failed");
    assert.ok((job.error ?? "").includes(FIDELITY_REFUSAL));
  });

  it("a terminal async place_subject failure fails instead of re-queueing guided", async () => {
    placeMode = "async-fail";
    critiqueScore = 0.95;
    const { read } = await runPack();
    const campaign = await awaitSettled(read);
    assert.equal(placeCalls().length, 1, "rejected tool never retried");
    assert.equal(mediaCalls().length, 0, "no guided re-queue for strict stages");
    const job = campaign.jobs.find((j) => j.id === "job_pack")!;
    assert.equal(job.status, "failed");
    assert.ok((job.error ?? "").includes(FIDELITY_REFUSAL));
  });

  it("a failed identity check blocks delivery with no preserved claim", async () => {
    placeMode = "inline";
    critiqueScore = 0.2;
    const { read } = await runPack();
    await awaitSettled(read);
    const campaign = await awaitReceipts(read);
    const job = campaign.jobs.find((j) => j.id === "job_pack")!;
    assert.equal(job.requestMeta?.fidelityCheck, "failed");
    const receipt = campaign.receipts.find((r) => r.jobId === "job_pack")!;
    assert.equal(receipt.fidelityCheck, "failed");
    assert.equal(receipt.sourceFidelity, "product-preserving");
    assert.equal(receipt.deliveryBlocked, "fidelity_check_failed");
  });

  it("a passed identity check earns the preserved claim with no block", async () => {
    placeMode = "inline";
    critiqueScore = 0.95;
    const { read } = await runPack();
    await awaitSettled(read);
    const campaign = await awaitReceipts(read);
    const receipt = campaign.receipts.find((r) => r.jobId === "job_pack")!;
    assert.equal(receipt.fidelityCheck, "passed");
    assert.equal(receipt.sourceFidelity, "product-preserving");
    assert.equal(receipt.deliveryBlocked, undefined);
    assert.equal(critiqueCalls().length, 1, "exactly one identity check per placed output");
  });
});

function blockedReceipt(): DerivativeReceipt {
  return {
    id: "rcpt_fid",
    campaignId: "cmp_fid",
    jobId: "job_pack",
    label: "Clean packshot (1:1)",
    mediaType: "image",
    format: "1:1",
    outputUrl: "https://cdn.example/placed.png",
    capability: "flux-dev",
    promptHash: "ph",
    claimsUsed: [],
    derivedFrom: { sourceMediaId: "m1", passportId: "p1", productFactsId: "f1" },
    generatedAt: "2026-01-01T00:00:00.000Z",
    storageStatus: "stored",
    visibility: "shared",
    sourceFidelity: "product-preserving",
    fidelityCheck: "failed",
    deliveryBlocked: "fidelity_check_failed"
  } as DerivativeReceipt;
}

describe("strict motion never dispatches (no validated video pipeline)", () => {
  before(() => {
    for (const k of ["DKG_MODE", "LIVEPEER_QUALITY_CHECK", "LIVEPEER_PLACE_SUBJECT", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.DKG_MODE = "__unsupported_test__";
    process.env.LIVEPEER_QUALITY_CHECK = "off";
    delete process.env.LIVEPEER_PLACE_SUBJECT;
    delete process.env.CLOUDINARY_CLOUD_NAME;
    delete process.env.CLOUDINARY_API_KEY;
    delete process.env.CLOUDINARY_API_SECRET;
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

  function motionDb(): Database {
    const db = emptyDb();
    db.sourceMedia.push({ id: "m1", creatorId: "c1", title: "approved product reference", type: "image", url: SOURCE, hash: "hash" });
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
    const heroJob: ProductionJob = {
      id: "job_hero",
      campaignId: "cmp_motion",
      stageId: "hero",
      kind: "text-to-image",
      capability: IMAGE_CAP,
      requestedCapability: IMAGE_CAP,
      qualityProfile: "balanced",
      role: "conceptImage",
      prompt: "story keyframe",
      status: "ready_to_share",
      providerOutputUrl: HERO_OUT,
      outputUrl: HERO_OUT,
      costUsd: 0.05,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    } as ProductionJob;
    const tourJob: ProductionJob = {
      id: "job_tour",
      campaignId: "cmp_motion",
      stageId: "tour",
      kind: "image-to-video",
      capability: MOTION_CAP,
      requestedCapability: MOTION_CAP,
      qualityProfile: "balanced",
      role: "imageToVideo",
      prompt: "slow product reveal",
      status: "queued",
      startedAt: new Date().toISOString()
    } as ProductionJob;
    const campaign = {
      id: "cmp_motion",
      title: "motion probe",
      brand: "brand",
      productName: "product",
      request: {
        platform: "instagram",
        country: "GR",
        requestedClaims: [],
        transformation: "video",
        creativeBrief: "A sufficiently long creative brief for the motion probe.",
        qualityProfile: "balanced"
      },
      status: "generating",
      preflight: {
        decision: "allow",
        checkedAt: new Date().toISOString(),
        blockers: [],
        allowedClaims: [],
        promptConstraints: ["Be honest."],
        plan: [
          {
            id: "hero",
            kind: "text-to-image",
            capability: IMAGE_CAP,
            label: "Story keyframe",
            format: "9:16",
            dependsOnStageIds: [],
            inputSource: "approved-source",
            qualityProfile: "balanced",
            role: "conceptImage"
          },
          {
            id: "tour",
            kind: "image-to-video",
            capability: MOTION_CAP,
            label: "Product tour",
            format: "9:16",
            dependsOnStageIds: ["hero"],
            inputSource: "stage-output",
            qualityProfile: "balanced",
            role: "imageToVideo",
            fidelity: "product-preserving",
            durationSeconds: 5,
            requestedDurationSeconds: 5
          }
        ],
        queriedRights: [],
        queriedFacts: [],
        sparqlPreview: ""
      },
      jobs: [heroJob, tourJob],
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

  it("a strict motion stage fails with zero provider calls and no output", async () => {
    const { store, read } = memoryStore(motionDb());
    setRunStore(store);
    seen = [];
    try {
      const submitted = await submitRun({ campaignId: "cmp_motion", workspaceId: "ws1" });
      assert.equal(submitted.created, true);
      await pumpRun("ws1", "cmp_motion", { budgetMs: 30000 });
      const start = Date.now();
      for (;;) {
        const tour = read().campaigns.find((c) => c.id === "cmp_motion")!.jobs.find((j) => j.id === "job_tour")!;
        if (tour.status !== "queued" && tour.status !== "generating") break;
        if (Date.now() - start > 25000) throw new Error("motion job did not settle");
        await new Promise((r) => setTimeout(r, 250));
      }
      const tour = read().campaigns.find((c) => c.id === "cmp_motion")!.jobs.find((j) => j.id === "job_tour")!;
      assert.equal(tour.status, "failed");
      assert.ok((tour.error ?? "").includes(FIDELITY_REFUSAL));
      assert.equal(
        seen.filter((s) => s.tool === "create_media" || s.tool === "place_subject").length,
        0,
        "no animate, generate, or placement call for strict motion"
      );
      assert.deepEqual(
        read().campaigns.find((c) => c.id === "cmp_motion")!.receipts,
        [],
        "no strict-motion output exists to deliver or approve"
      );
    } finally {
      setRunStore(null);
    }
  });
});

describe("fidelity approval gate", () => {
  it("refuses packs with a failed identity check, even alongside good outputs", () => {
    const good = { ...blockedReceipt(), id: "rcpt_good", deliveryBlocked: undefined, fidelityCheck: "passed" as const };
    const readyJob = {
      id: "job_pack",
      campaignId: "cmp_fid",
      stageId: "packshot",
      kind: "image-to-image",
      capability: IMAGE_CAP,
      prompt: "p",
      status: "ready_to_share",
      startedAt: new Date().toISOString()
    } as ProductionJob;
    const r = checkApprovalEligibility(
      {
        status: "review",
        preflight: { decision: "allow" } as Campaign["preflight"],
        jobs: [readyJob],
        receipts: [blockedReceipt(), good],
        passportId: "pp1"
      },
      { ok: true, passport: { id: "pp1" } as PermissionPassport } as AuthorizationRevalidation
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /Fidelity check failed/);
    assert.match(r.error, /Could not preserve the approved product\/property/);
  });
});

describe("evaluateFidelityCheck (fail closed)", () => {
  it("passes only explicit passing scores at or above threshold", () => {
    assert.equal(evaluateFidelityCheck({ score: 0.95, passed: true }), "passed");
    assert.equal(evaluateFidelityCheck({ score: 0.8, passed: true }), "passed");
    assert.equal(evaluateFidelityCheck({ score: 0.79, passed: true }), "failed");
    assert.equal(evaluateFidelityCheck({ score: 0.2, passed: false }), "failed");
    assert.equal(evaluateFidelityCheck({ score: null, passed: true }), "failed", "unparseable never passes");
    assert.equal(evaluateFidelityCheck({ score: NaN, passed: true }), "failed");
    assert.equal(evaluateFidelityCheck(null), "failed", "missing critique never passes");
  });
});

describe("buildReceipt fidelity mapping", () => {  function baseJob(): ProductionJob {
    return {
      id: "job_pack",
      campaignId: "cmp_fidelity",
      stageId: "packshot",
      kind: "image-to-image",
      capability: "flux-dev",
      prompt: "p",
      status: "ready_to_share",
      startedAt: new Date().toISOString()
    } as ProductionJob;
  }

  function baseCampaign(): Campaign {
    return {
      id: "cmp_fidelity",
      preflight: { plan: [strictStage()], allowedClaims: [] }
    } as unknown as Campaign;
  }

  it("maps a failed check to a delivery block and keeps the requirement", () => {
    const job = { ...baseJob(), requestMeta: { fidelityCheck: "failed" as const } };
    const receipt = buildReceipt(baseCampaign(), job, "https://cdn.example/placed.png", IMAGE_CAP, null);
    assert.equal(receipt.deliveryBlocked, "fidelity_check_failed");
    assert.equal(receipt.fidelityCheck, "failed");
    assert.equal(receipt.sourceFidelity, "product-preserving");
  });

  it("maps a passed check with no block", () => {
    const job = { ...baseJob(), requestMeta: { fidelityCheck: "passed" as const } };
    const receipt = buildReceipt(baseCampaign(), job, "https://cdn.example/placed.png", IMAGE_CAP, null);
    assert.equal(receipt.deliveryBlocked, undefined);
    assert.equal(receipt.fidelityCheck, "passed");
    assert.equal(receipt.sourceFidelity, "product-preserving");
  });

  it("leaves conceptual receipts untouched", () => {
    const job = baseJob();
    const campaign = { id: "cmp", preflight: { plan: [], allowedClaims: [] } } as unknown as Campaign;
    const receipt = buildReceipt(campaign, job, "https://cdn.example/guided.png", IMAGE_CAP, null);
    assert.equal("sourceFidelity" in receipt, false);
    assert.equal("fidelityCheck" in receipt, false);
    assert.equal("deliveryBlocked" in receipt, false);
  });
});

describe("fidelity recipes", () => {
  it("product launch packshots and ads default to product-preserving", () => {
    const template = getTemplate("product-launch")!;
    const flagged = new Map(template.recipes.filter((r) => r.fidelity).map((r) => [r.id, r.fidelity]));
    for (const id of ["pl-packshot-11", "pl-lifestyle-43", "pl-detail-11", "pl-social-43", "pl-banner-169", "pl-lifestyle-169"]) {
      assert.equal(flagged.get(id), "product-preserving", `${id} must default to product-preserving`);
    }
    assert.equal(flagged.has("pl-story-916"), false, "concept story stays conceptual");
    assert.equal(flagged.has("pl-motion-reveal"), false, "motion stays conceptual");
  });

  it("real-estate listing images default to property-preserving, dusk stays conceptual", () => {
    const template = getTemplate("real-estate")!;
    const flagged = new Map(template.recipes.filter((r) => r.fidelity).map((r) => [r.id, r.fidelity]));
    for (const id of ["re-cover-916", "re-listing-11", "re-hero-169", "re-detail-43", "re-detail-11", "re-detail-169"]) {
      assert.equal(flagged.get(id), "property-preserving", `${id} must default to property-preserving`);
    }
    assert.equal(flagged.has("re-dusk-916"), false, "explicitly conceptual dusk grade stays conceptual");
  });

  it("creator campaign stays fully conceptual", () => {
    const template = getTemplate("creator-campaign")!;
    assert.deepEqual(template.recipes.filter((r) => r.fidelity), []);
  });

  it("strict packs defer motion (never executable); creator motion stays executable", () => {
    for (const id of ["product-launch", "real-estate"] as const) {
      const template = getTemplate(id)!;
      const motion = template.recipes.filter((r) => r.kind === "image-to-video");
      assert.ok(motion.length > 0, `${id} still lists its motion recipes`);
      for (const recipe of motion) {
        assert.equal(recipe.execution, "deferred", `${recipe.id} must not execute`);
        assert.equal(recipe.deferredReason, DEFERRED_MOTION_REASON);
      }
    }
    const creator = getTemplate("creator-campaign")!;
    const creatorMotion = creator.recipes.filter((r) => r.kind === "image-to-video");
    assert.ok(creatorMotion.length > 0);
    for (const recipe of creatorMotion) {
      assert.equal(recipe.execution, "create_media", `${recipe.id} stays executable conceptual motion`);
    }
  });

  it("toPlanStages threads strict fidelity onto stages only", () => {
    const stages = toPlanStages(
      {
        template: getTemplate("product-launch")!,
        stages: [
          {
            recipe: {
              id: "pl-packshot-11",
              label: "Clean packshot (1:1)",
              kind: "image-to-image",
              role: "productPackshot",
              format: "1:1",
              inputSource: "approved-source",
              dependsOn: [],
              assetType: "image",
              optional: false,
              quickPick: true,
              execution: "create_media",
              promptKey: "packshot",
              fidelity: "product-preserving"
            } as TemplateStageRecipe,
            capability: IMAGE_CAP
          },
          {
            recipe: {
              id: "pl-story-916",
              label: "Story keyframe",
              kind: "text-to-image",
              role: "conceptImage",
              format: "9:16",
              inputSource: "approved-source",
              dependsOn: [],
              assetType: "image",
              optional: false,
              quickPick: true,
              execution: "create_media",
              promptKey: "story"
            } as TemplateStageRecipe,
            capability: IMAGE_CAP
          }
        ],
        deferred: [],
        executableCount: 2,
        outputCount: 2,
        autoIncluded: []
      },
      "balanced"
    );
    assert.equal(stages[0].fidelity, "product-preserving");
    assert.equal("fidelity" in stages[1], false);
  });
});
