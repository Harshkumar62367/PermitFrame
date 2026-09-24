import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Campaign, Database, ProductionJob } from "../types";
import { emptyDb } from "../store";
import { setRunStore, memoryStore } from "./run-store";
import { pumpRun } from "./runner";
import {
  MODEL_OVERRIDE_ROLES,
  MODEL_OVERRIDE_STAGE_ROLES,
  MODEL_OVERRIDE_UNAVAILABLE,
  getTemplate,
  type TemplateSelection
} from "./template-catalogue";
import { modelChoicesForOverride, type CatalogueSnapshot } from "./catalogue";
import { checkModelOverrides, validateTemplateSelection } from "./template-validation";
import { buildTemplateStages, overrideForRole } from "./template-plan-builder";

/**
 * Expert model choice (Short Clip advanced override). No network, no paid
 * calls, no inference: live discovery is a synthetic snapshot, dispatch is
 * a stubbed-fetch pumpRun - the only provider-shaped traffic is free
 * list_capabilities/get_pricing reads.
 *
 * - Choices come from the live snapshot intersected with the role's
 *   verified family; display data is name + description only.
 * - Validation normalizes (absent/blank ≡ Automatic) and rejects bad keys,
 *   non-strings, and over-long names; availability/compatibility is
 *   enforced live with one exact safe refusal.
 * - The builder pins matching stages with requestedCapability and never
 *   records a fallback for them; automatic resolution is byte-identical.
 * - A pinned model that vanishes before dispatch fails the job with the
 *   exact static message and zero create_media calls.
 */

const PINNED_IMAGE = "flux-pro";
const PINNED_MOTION = "kling-v3-turbo-i2v";

function snapshot(
  entries: { name: string; kind?: string; availability?: string; description?: string; modelId?: string }[],
  reachable = true
): CatalogueSnapshot {
  return {
    reachable,
    authMode: "keyless-hosted",
    totalReported: entries.length,
    checkedAt: new Date().toISOString(),
    capabilities: entries.map((c) => ({
      name: c.name,
      kind: c.kind ?? "ai",
      availability: c.availability ?? "available",
      modelId: c.modelId ?? "internal-xyz",
      description: c.description ?? ""
    }))
  };
}

function liveSnapshot(): CatalogueSnapshot {
  return snapshot([
    { name: "flux-schnell", description: "Fast draft previews." },
    { name: "flux-dev", description: "Balanced image model." },
    { name: PINNED_IMAGE, description: "Premium image model with a very long provider blurb. " + "x".repeat(500) },
    { name: "gemini-image" },
    { name: "seedream-5-lite", availability: "unavailable" },
    { name: PINNED_MOTION, description: "Fast motion model." },
    { name: "pixverse-i2v" },
    { name: "topaz-upscale", description: "Upscaler." },
    { name: "minimax-music-3", description: "Music." },
    { name: "nano-banana", description: "Edit model." },
    { name: "pixelcut-product-photo", description: "Packshots." },
    { name: "nemotron-asr", description: "Transcription." }
  ]);
}

function baseSelection(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    templateId: "creator-campaign",
    packSize: "campaign",
    assetTypes: ["image", "motion"],
    qualityProfile: "balanced",
    ...over
  };
}

describe("model choice discovery", () => {
  it("offers only available verified-family models with safe display data", () => {
    const snap = liveSnapshot();
    const image = modelChoicesForOverride(snap, "conceptImage");
    const names = image.map((c) => c.name);
    assert.ok(names.includes("flux-dev"));
    assert.ok(names.includes(PINNED_IMAGE));
    assert.ok(names.includes("flux-schnell"));
    assert.ok(names.includes("gemini-image"));
    assert.ok(!names.includes("seedream-5-lite"), "unavailable ladder member excluded");
    for (const banned of [PINNED_MOTION, "pixverse-i2v", "topaz-upscale", "minimax-music-3", "nano-banana", "pixelcut-product-photo", "nemotron-asr"]) {
      assert.ok(!names.includes(banned), `${banned} is not an image choice`);
    }
    for (const c of image) {
      assert.deepEqual(Object.keys(c).sort(), ["description", "name"]);
    }
    const motion = modelChoicesForOverride(snap, "imageToVideo");
    const motionNames = motion.map((c) => c.name);
    assert.ok(motionNames.includes(PINNED_MOTION));
    assert.ok(motionNames.includes("pixverse-i2v"));
    assert.ok(!motionNames.includes("flux-dev"), "image model is not a motion choice");
    assert.ok(!motionNames.includes("topaz-upscale"), "upscale is never a motion choice");
  });

  it("caps descriptions and returns nothing when unreachable", () => {
    const snap = liveSnapshot();
    const pinned = modelChoicesForOverride(snap, "conceptImage").find((c) => c.name === PINNED_IMAGE)!;
    assert.ok(pinned.description.length <= 200);
    assert.ok(pinned.description.startsWith("Premium image model"));
    assert.deepEqual(modelChoicesForOverride(snapshot([], false), "conceptImage"), []);
    assert.deepEqual(modelChoicesForOverride({ ...snap, reachable: false }, "imageToVideo"), []);
  });

  it("exposes exactly the two override roles and their stage mapping", () => {
    assert.deepEqual(MODEL_OVERRIDE_ROLES, ["conceptImage", "imageToVideo"]);
    assert.deepEqual(MODEL_OVERRIDE_STAGE_ROLES.conceptImage, ["conceptImage", "sourceGuidedImage"]);
    assert.deepEqual(MODEL_OVERRIDE_STAGE_ROLES.imageToVideo, ["imageToVideo"]);
    assert.equal(
      MODEL_OVERRIDE_UNAVAILABLE,
      "Selected model is not currently available for this deliverable. Refresh the model list or choose Automatic."
    );
  });
});

describe("model override validation", () => {
  it("legacy selections validate with no overrides key", () => {
    const r = validateTemplateSelection(baseSelection(), 16);
    assert.equal(r.ok, true);
    if (!r.ok || !r.spec) return;
    assert.ok(!("modelOverrides" in r.spec));
  });

  it("normalizes: trims, drops blanks, accepts explicit pins", () => {
    const r = validateTemplateSelection(baseSelection({ modelOverrides: { conceptImage: "  flux-dev  ", imageToVideo: "" } }), 16);
    assert.equal(r.ok, true);
    if (!r.ok || !r.spec) return;
    assert.deepEqual(r.spec.modelOverrides, { conceptImage: "flux-dev" });
  });

  it("rejects unknown keys, non-strings, and over-long names", () => {
    const badKey = validateTemplateSelection(baseSelection({ modelOverrides: { upscale: "topaz-upscale" } }), 16);
    assert.equal(badKey.ok, false);
    assert.match(badKey.error ?? "", /Unknown model override "upscale"/);
    const badType = validateTemplateSelection(baseSelection({ modelOverrides: { conceptImage: 42 } }), 16);
    assert.equal(badType.ok, false);
    assert.match(badType.error ?? "", /must be a model name/);
    const badLong = validateTemplateSelection(baseSelection({ modelOverrides: { conceptImage: "x".repeat(121) } }), 16);
    assert.equal(badLong.ok, false);
    assert.match(badLong.error ?? "", /120 characters or fewer/);
    assert.equal(validateTemplateSelection(baseSelection({ modelOverrides: [] }), 16).ok, false);
  });

  it("accepts available compatible pins on preview/apply checks", () => {
    const template = getTemplate("creator-campaign")!;
    const spec = validateTemplateSelection(
      baseSelection({ modelOverrides: { conceptImage: "flux-dev", imageToVideo: PINNED_MOTION } }),
      16
    );
    assert.equal(spec.ok, true);
    if (!spec.ok || !spec.spec) return;
    assert.deepEqual(checkModelOverrides(spec.spec, template, liveSnapshot()), { ok: true });
  });

  it("rejects unavailable and incompatible pins with the exact safe error", () => {
    const template = getTemplate("creator-campaign")!;
    for (const modelOverrides of [
      { conceptImage: "seedream-5-lite" },
      { conceptImage: "nope-not-real" },
      { conceptImage: PINNED_MOTION },
      { imageToVideo: "flux-dev" }
    ]) {
      const spec = validateTemplateSelection(baseSelection({ modelOverrides }), 16);
      assert.equal(spec.ok, true);
      if (!spec.ok || !spec.spec) return;
      assert.deepEqual(checkModelOverrides(spec.spec, template, liveSnapshot()), {
        ok: false,
        error: MODEL_OVERRIDE_UNAVAILABLE
      });
    }
  });

  it("rejects a pin with no matching selected executable recipe", () => {
    const template = getTemplate("creator-campaign")!;
    const spec = validateTemplateSelection(
      baseSelection({ assetTypes: ["image"], modelOverrides: { imageToVideo: PINNED_MOTION } }),
      16
    );
    assert.equal(spec.ok, true);
    if (!spec.ok || !spec.spec) return;
    const r = checkModelOverrides(spec.spec, template, liveSnapshot());
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /needs a selected motion recipe/);
  });

  it("defers to the dispatch guard when discovery is unreachable", () => {
    const template = getTemplate("creator-campaign")!;
    const spec = validateTemplateSelection(baseSelection({ modelOverrides: { conceptImage: "flux-dev" } }), 16);
    assert.equal(spec.ok, true);
    if (!spec.ok || !spec.spec) return;
    assert.deepEqual(checkModelOverrides(spec.spec, template, snapshot([], false)), { ok: true });
  });

  it("absent overrides always pass the live check", () => {
    const template = getTemplate("creator-campaign")!;
    const spec = validateTemplateSelection(baseSelection(), 16);
    assert.equal(spec.ok, true);
    if (!spec.ok || !spec.spec) return;
    assert.deepEqual(checkModelOverrides(spec.spec, template, liveSnapshot()), { ok: true });
  });
});

describe("model override plan resolution", () => {
  function build(overrides?: Partial<Record<"conceptImage" | "imageToVideo", string>>) {
    const template = getTemplate("creator-campaign")!;
    const spec: TemplateSelection = {
      templateId: "creator-campaign",
      packSize: "campaign",
      assetTypes: ["image", "motion"],
      qualityProfile: "balanced",
      ...(overrides ? { modelOverrides: overrides } : {})
    };
    const r = buildTemplateStages(template, spec, (role) => ({
      capability: role === "imageToVideo" ? PINNED_MOTION : "flux-dev"
    }));
    if (!r.ok) throw new Error(`unexpected build failure: ${r.error}`);
    return r.plan;
  }

  it("pins every matching stage with no fallback recording", () => {
    const plan = build({ conceptImage: PINNED_IMAGE });
    const pinned = plan.stages.filter((s) => s.recipe.role === "conceptImage" || s.recipe.role === "sourceGuidedImage");
    assert.ok(pinned.length > 0);
    for (const s of pinned) {
      assert.equal(s.capability, PINNED_IMAGE);
      assert.equal(s.requestedCapability, PINNED_IMAGE);
      assert.equal(s.fallbackFrom, undefined);
    }
    const motion = plan.stages.filter((s) => s.recipe.role === "imageToVideo");
    assert.ok(motion.length > 0);
    for (const s of motion) {
      assert.equal(s.capability, PINNED_MOTION);
      assert.equal(s.requestedCapability, undefined);
    }
  });

  it("pins motion stages independently", () => {
    const plan = build({ imageToVideo: "pixverse-i2v" });
    for (const s of plan.stages.filter((st) => st.recipe.role === "imageToVideo")) {
      assert.equal(s.capability, "pixverse-i2v");
      assert.equal(s.requestedCapability, "pixverse-i2v");
    }
    for (const s of plan.stages.filter((st) => st.recipe.role !== "imageToVideo")) {
      assert.equal(s.requestedCapability, undefined);
    }
  });

  it("automatic resolution is byte-identical with no requested markers", () => {
    const plan = build(undefined);
    for (const s of plan.stages) {
      assert.equal(s.requestedCapability, undefined);
      assert.equal(s.fallbackFrom, undefined);
    }
    assert.deepEqual(
      plan.stages.map((s) => [s.recipe.id, s.capability]),
      build({}).stages.map((s) => [s.recipe.id, s.capability])
    );
  });

  it("overrideForRole maps the concept family and motion only", () => {
    assert.equal(overrideForRole("conceptImage", { conceptImage: PINNED_IMAGE }), PINNED_IMAGE);
    assert.equal(overrideForRole("sourceGuidedImage", { conceptImage: PINNED_IMAGE }), PINNED_IMAGE);
    assert.equal(overrideForRole("imageToVideo", { conceptImage: PINNED_IMAGE }), undefined);
    assert.equal(overrideForRole("imageToVideo", { imageToVideo: PINNED_MOTION }), PINNED_MOTION);
    assert.equal(overrideForRole("upscale", { conceptImage: PINNED_IMAGE, imageToVideo: PINNED_MOTION }), undefined);
    assert.equal(overrideForRole("conceptImage", undefined), undefined);
  });
});

/* Dispatch-guard integration: stubbed provider, real pumpRun. */

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
      // PINNED_IMAGE is deliberately absent: the pin went stale after apply.
      return send(
        ok({
          total: 1,
          capabilities: [{ name: "flux-dev", kind: "ai", availability: "available", model_id: "", description: "" }]
        })
      );
    }
    if (tool === "get_pricing") return send(ok({ capabilities: [] }));
    seen.push({ tool, args });
    if (tool === "create_media") {
      throw new Error("create_media must never be called for an unavailable pin");
    }
    return send(ok({}));
  }) as typeof fetch;
}

function seedDb(tag: string): Database {
  const db = emptyDb();
  const cmpId = `cmp_${tag}`;
  const runId = `run_${tag}`;
  db.sourceMedia.push({
    id: "m1",
    creatorId: "c1",
    title: "approved creator media",
    type: "image",
    url: "https://source.example/approved.png",
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
    title: "override pack",
    brand: "brand",
    productName: "product",
    request: {
      platform: "instagram",
      country: "GR",
      requestedClaims: [],
      transformation: "video",
      creativeBrief: "A sufficiently long creative brief for the override probe.",
      qualityProfile: "balanced",
      productionSpec: {
        templateId: "creator-campaign",
        packSize: "campaign",
        assetTypes: ["image", "motion"],
        qualityProfile: "balanced",
        modelOverrides: { conceptImage: PINNED_IMAGE }
      }
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
          id: "keyframe",
          kind: "text-to-image",
          capability: PINNED_IMAGE,
          requestedCapability: PINNED_IMAGE,
          label: "Campaign keyframe (9:16)",
          format: "9:16",
          dependsOnStageIds: [],
          inputSource: "approved-source",
          qualityProfile: "balanced",
          role: "conceptImage"
        }
      ],
      queriedRights: [],
      queriedFacts: [],
      sparqlPreview: ""
    },
    jobs: [
      {
        id: "job_keyframe",
        campaignId: cmpId,
        stageId: "keyframe",
        kind: "text-to-image",
        capability: PINNED_IMAGE,
        requestedCapability: PINNED_IMAGE,
        qualityProfile: "balanced",
        role: "conceptImage",
        prompt: "still brief",
        status: "queued",
        startedAt: new Date().toISOString()
      }
    ],
    receipts: [],
    runs: [
      {
        id: runId,
        campaignId: cmpId,
        stageIds: ["keyframe"],
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

const savedEnv: Record<string, string | undefined> = {};

describe("pinned override dispatch guard", () => {
  before(() => {
    for (const k of ["DKG_MODE", "LIVEPEER_QUALITY_CHECK", "LIVEPEER_PLACE_SUBJECT"]) {
      savedEnv[k] = process.env[k];
    }
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
  });

  it("fails the job with the exact static message and zero create_media calls", async () => {
    seen = [];
    const { store, read } = memoryStore(seedDb("pin"));
    setRunStore(store);
    const pumped = await pumpRun("ws1", "cmp_pin", { runId: "run_pin", budgetMs: 15000 });
    assert.equal(pumped.pumped, true);
    const job = read().campaigns[0].jobs.find((j) => j.stageId === "keyframe")! as ProductionJob;
    assert.equal(job.status, "failed");
    assert.equal(job.error, MODEL_OVERRIDE_UNAVAILABLE);
    assert.equal(job.requestedCapability, PINNED_IMAGE);
    assert.equal(job.actualCapability, undefined);
    assert.deepEqual(
      seen.filter((s) => s.tool === "create_media"),
      [],
      "no provider media call for an unavailable pin"
    );
  });
});
