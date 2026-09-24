import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Campaign, Database, ProductionJob, ProductionStagePlan, SourceMedia } from "../types";
import { emptyDb } from "../store";
import { setRunStore, memoryStore } from "./run-store";
import { submitRun } from "./run-submit";
import { pumpRun } from "./runner";
import { preservationContextFor } from "./run-scope";

/**
 * Single-resolution upload dispatch. A deterministic counting fake stands
 * in for Cloudinary URL generation (no network): every call returns a
 * different temporary URL, which is exactly the hazard the old code had -
 * two independent resolutions could differ and falsely fail the
 * byte-for-byte ownership check. The suite proves one dispatch operation
 * resolves once, threads that exact value through planning, slots,
 * preservation, ownership, and provider submission, and persists nothing
 * temporary. Legacy URL sources keep byte-for-byte behavior.
 */

const UPLOAD_REF = "private:cloudinary:src_abcdef123456";
const OUT = "https://cdn.example/upload-dispatch-out.png";
const IMAGE_CAP = "flux-dev";

function uploadRow(): SourceMedia {
  return {
    id: "med_up",
    creatorId: "c1",
    title: "uploaded original",
    type: "image",
    url: UPLOAD_REF,
    hash: "bytehash",
    source: "upload",
    storage: { provider: "cloudinary", publicId: "src_abcdef123456", resourceType: "image", format: "png", bytes: 13 }
  };
}

function planStages(): ProductionStagePlan[] {
  return [
    { id: "keyframe", kind: "text-to-image", capability: IMAGE_CAP, label: "Keyframe", format: "9:16", dependsOnStageIds: [], inputSource: "approved-source", qualityProfile: "balanced", role: "conceptImage" }
  ];
}

function mkJob(stageId: string, id: string, status: ProductionJob["status"]): ProductionJob {
  return {
    id,
    campaignId: "cmp_updispatch",
    stageId,
    kind: "text-to-image",
    capability: IMAGE_CAP,
    requestedCapability: IMAGE_CAP,
    qualityProfile: "balanced",
    role: "conceptImage",
    prompt: "upload dispatch brief",
    status,
    startedAt: new Date().toISOString()
  } as ProductionJob;
}

function seedDb(media: SourceMedia): Database {
  const db = emptyDb();
  db.sourceMedia.push(media);
  db.passports.push({
    id: "p1",
    creatorId: "c1",
    creatorName: "Creator",
    sourceMediaIds: [media.id],
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
    id: "cmp_updispatch",
    title: "upload dispatch pack",
    brand: "brand",
    productName: "product",
    request: {
      platform: "instagram",
      country: "GR",
      requestedClaims: [],
      transformation: "image",
      creativeBrief: "A sufficiently long creative brief for the upload dispatch probe.",
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
    jobs: [mkJob("keyframe", "job_k", "queued")],
    receipts: [],
    runs: [],
    creatorId: "c1",
    sourceMediaId: media.id,
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
      return send(ok({ total: 1, capabilities: [{ name: IMAGE_CAP, kind: "ai", availability: "available", model_id: "", description: "" }] }));
    }
    if (tool === "get_pricing") return send(ok({ capabilities: [] }));
    seen.push({ tool, args });
    if (tool === "create_media") return send(ok({ job_id: "mjob_up_1", status: "queued" }));
    if (tool === "get_create_media" || tool === "subscribe_progress") {
      return send(ok({ job_id: String(args.job_id ?? args.jobId ?? ""), status: "completed", url: OUT, cost_paid_usd: 0.05 }));
    }
    return send(ok({}));
  }) as typeof fetch;
}

const savedEnv: Record<string, string | undefined> = {};

async function awaitSettled(read: () => Database, timeoutMs = 25000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const jobs = read().campaigns.find((c) => c.id === "cmp_updispatch")!.jobs;
    if (jobs.every((j) => j.status !== "queued" && j.status !== "generating")) return;
    if (Date.now() - start > timeoutMs) throw new Error("jobs did not settle");
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe("single-resolution upload dispatch", () => {
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
  });

  it("one dispatch resolves once, passes ownership, and submits exactly that URL", async () => {
    const { store, read } = memoryStore(seedDb(uploadRow()));
    setRunStore(store);
    seen = [];
    // Deterministic stand-in for Cloudinary temporary URLs: every call
    // differs, so any second independent resolution would observably break
    // the byte-for-byte ownership check or the submitted URL.
    const issued: string[] = [];
    let calls = 0;
    const fakeResolver = (media: SourceMedia) => {
      calls += 1;
      assert.equal(media.id, "med_up");
      const url = `https://temp.example/${calls}/asset.png?e=9999999999`;
      issued.push(url);
      return url;
    };
    const submitted = await submitRun({ campaignId: "cmp_updispatch", workspaceId: "ws1" });
    assert.equal(submitted.created, true);
    await pumpRun("ws1", "cmp_updispatch", { budgetMs: 20000, resolveSourceUrl: fakeResolver });
    await awaitSettled(read);

    // The hazard is real: consecutive generations differ.
    assert.ok(issued.length >= 1);
    assert.equal(new Set(issued).size, issued.length);
    if (issued.length > 1) assert.notEqual(issued[0], issued[1]);

    // Exactly the issued URL reached the provider - never the stored
    // reference, never a mismatched second generation.
    const submits = seen.filter((s) => s.tool === "create_media");
    assert.ok(submits.length >= 1, "expected at least one provider submit");
    for (const s of submits) {
      assert.ok(issued.includes(s.args.source_url as string), `submit carried an unissued URL: ${String(s.args.source_url)}`);
      assert.ok(!(s.args.source_url as string).includes("private:cloudinary"));
    }

    // Ownership passed: no job failed on preservation/ownership grounds.
    const jobs = read().campaigns.find((c) => c.id === "cmp_updispatch")!.jobs;
    for (const j of jobs) {
      assert.notEqual(j.status, "failed", `job failed with status ${j.status}`);
    }

    // Nothing temporary persisted: the stored reference is intact and no
    // campaign/job/receipt/event row carries a generated URL.
    const dump = JSON.stringify({
      campaigns: read().campaigns,
      sourceMedia: read().sourceMedia,
      events: read().events
    });
    assert.ok(!dump.includes("temp.example"), "temporary URL persisted");
    assert.ok(dump.includes(UPLOAD_REF), "stored controlled reference must remain");
    assert.equal(read().sourceMedia.find((m) => m.id === "med_up")!.url, UPLOAD_REF);
  });

  it("legacy public URL sources keep byte-for-byte dispatch behavior", async () => {
    const legacy = { id: "m1", creatorId: "c1", title: "approved creator media", type: "image", url: "https://source.example/approved-creator.png", hash: "hash" } as SourceMedia;
    const { store, read } = memoryStore(seedDb(legacy));
    setRunStore(store);
    seen = [];
    const submitted = await submitRun({ campaignId: "cmp_updispatch", workspaceId: "ws1" });
    assert.equal(submitted.created, true);
    await pumpRun("ws1", "cmp_updispatch", { budgetMs: 20000 });
    await awaitSettled(read);
    const submits = seen.filter((s) => s.tool === "create_media");
    assert.ok(submits.length >= 1);
    for (const s of submits) {
      assert.equal(s.args.source_url, "https://source.example/approved-creator.png");
    }
  });

  it("a would-be second URL cannot pass ownership for the first URL's slot", () => {
    // Pure-level proof of the bug being fixed: preservation compares
    // exactly, so threading (not re-resolving) is what keeps uploads owned.
    const row = uploadRow();
    const campaign = { id: "cmp_x", sourceMediaId: "med_up" } as Campaign;
    const slot = { inputUrl: "https://temp.example/1/asset.png?e=9", resolvedInputSource: "approved-source" } as const;
    const mapped = [{ ...row, url: slot.inputUrl }];
    const { ctx } = preservationContextFor(campaign, mapped, { id: "s", kind: "text-to-image", role: "conceptImage" } as never, { id: "j" } as never, slot as never);
    assert.equal(ctx.sourceOwnedByCampaign, true);
    const remapped = [{ ...row, url: "https://temp.example/2/asset.png?e=9" }];
    const again = preservationContextFor(campaign, remapped, { id: "s", kind: "text-to-image", role: "conceptImage" } as never, { id: "j" } as never, slot as never);
    assert.equal(again.ctx.sourceOwnedByCampaign, false);
  });
});

describe("no re-resolution in dispatch code", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (name: string) => readFileSync(join(here, name), "utf8");

  it("run-dispatch never resolves source URLs (slot carries the single value)", () => {
    assert.ok(!read("run-dispatch.ts").includes("resolveSourceMediaUrl"));
  });

  it("run-scope never resolves source URLs (pure comparison only)", () => {
    assert.ok(!read("run-scope.ts").includes("resolveSourceMediaUrl"));
  });

  it("runner resolves at exactly one call site", () => {
    const matches = read("runner.ts").match(/resolveSource\(sourceMedia\)/g) ?? [];
    assert.equal(matches.length, 1);
  });
});
