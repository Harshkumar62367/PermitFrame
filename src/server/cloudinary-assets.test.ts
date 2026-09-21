import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq } from "drizzle-orm";
import {
  __setCloudinaryUpload,
  deliveryUrlFor,
  isCloudinaryConfigured,
  missingCloudinaryEnv,
  uploadRemoteAsset
} from "./cloudinary";
import { assetIdentity, assetResourceType, persistJobAsset } from "./asset-store";
import { isActiveJobStatus } from "./types";
import { receiptKa } from "./dkg/schemas";
import { buildPublicSnapshot } from "./verification-snapshot";
import type { Campaign, DerivativeReceipt } from "./types";
import { campaignAssets, workspaces } from "./db/schema";

dotenv.config({ path: ".env.local" });

/** Mocked Cloudinary transport everywhere — no real assets in tests. */

const SAVED_ENV = {
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET
};

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(SAVED_ENV)) setEnv(k, v);
  __setCloudinaryUpload(null);
}

describe("cloudinary env validation", () => {
  afterEach(restoreEnv);

  it("names missing vars without printing values", () => {
    setEnv("CLOUDINARY_CLOUD_NAME", undefined);
    setEnv("CLOUDINARY_API_KEY", undefined);
    setEnv("CLOUDINARY_API_SECRET", undefined);
    assert.deepEqual(missingCloudinaryEnv(), ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]);
    assert.equal(isCloudinaryConfigured(), false);
  });

  it("passes when all three are present", () => {
    setEnv("CLOUDINARY_CLOUD_NAME", "demo");
    setEnv("CLOUDINARY_API_KEY", "key");
    setEnv("CLOUDINARY_API_SECRET", "secret");
    assert.deepEqual(missingCloudinaryEnv(), []);
    assert.equal(isCloudinaryConfigured(), true);
  });
});

describe("cloudinary upload mapping (mocked transport)", () => {
  afterEach(restoreEnv);

  it("sends deterministic identity and maps the response", async () => {
    setEnv("CLOUDINARY_CLOUD_NAME", "demo");
    setEnv("CLOUDINARY_API_KEY", "key");
    setEnv("CLOUDINARY_API_SECRET", "secret");
    const seen: { current: { url: string; options: Record<string, unknown> } | null } = { current: null };
    __setCloudinaryUpload(async (url, options) => {
      seen.current = { url, options };
      return {
        public_id: "permitframe/ws/cmp/job",
        version: 7,
        secure_url: "https://res.cloudinary.com/demo/image/upload/v7/permitframe/ws/cmp/job",
        resource_type: "image",
        format: "png",
        bytes: 1234,
        width: 1024,
        height: 1792,
        created_at: "2026-09-21T00:00:00.000Z"
      };
    });
    const asset = await uploadRemoteAsset({
      sourceUrl: "https://agent.livepeer.org/a/xyz.jpg",
      folder: "permitframe/ws/cmp",
      publicId: "job_1",
      resourceType: "image"
    });
    assert.equal(asset.secureUrl, "https://res.cloudinary.com/demo/image/upload/v7/permitframe/ws/cmp/job");
    assert.equal(asset.version, 7);
    assert.equal(asset.bytes, 1234);
    assert.equal(asset.width, 1024);
    assert.equal(seen.current?.options.public_id, "job_1");
    assert.equal(seen.current?.options.overwrite, false);
    assert.equal(seen.current?.options.resource_type, "image");
  });

  it("rejects non-HTTPS provider URLs and incomplete responses", async () => {
    __setCloudinaryUpload(async () => ({}));
    await assert.rejects(
      () => uploadRemoteAsset({ sourceUrl: "http://evil/x.jpg", folder: "f", publicId: "p", resourceType: "auto" }),
      /HTTPS/
    );
    await assert.rejects(
      () => uploadRemoteAsset({ sourceUrl: "https://cdn.example/x.jpg", folder: "f", publicId: "p", resourceType: "auto" }),
      /incomplete/
    );
  });
});

describe("asset identity hygiene", () => {
  it("uses ids only — never emails, wallets, or prompt text", () => {
    const { folder, publicId } = assetIdentity("ws_1", "cmp_2", "job_3");
    assert.equal(folder, "permitframe/ws_1/cmp_2");
    assert.equal(publicId, "job_3");
    const hostile = assetIdentity("ws@x.com", "cmp 0xABC!", "job:1/2");
    assert.ok(!hostile.folder.includes("@") && !hostile.publicId.includes(":"));
  });

  it("maps kinds to definitive resource types", () => {
    assert.equal(assetResourceType("image-to-video"), "video");
    assert.equal(assetResourceType("text-to-image"), "image");
    assert.equal(assetResourceType("image-to-image"), "image");
    assert.equal(assetResourceType("upscale"), "image");
  });

  it("storage_pending counts as active; delivery urls derive without secrets", () => {
    assert.equal(isActiveJobStatus("storage_pending"), true);
    assert.equal(isActiveJobStatus("ready_to_share"), false);
    assert.equal(isActiveJobStatus("storage_retry_needed"), false);
    setEnv("CLOUDINARY_CLOUD_NAME", "demo");
    try {
      assert.equal(
        deliveryUrlFor("permitframe/ws/cmp/job", "video", 7),
        "https://res.cloudinary.com/demo/video/upload/v7/permitframe/ws/cmp/job"
      );
    } finally {
      restoreEnv();
    }
  });
});

describe("durable identity in proofs", () => {
  const baseReceipt = {
    id: "rcpt_1",
    campaignId: "cmp_1",
    jobId: "job_1",
    label: "keyframe",
    mediaType: "image",
    format: "9:16",
    outputUrl: "https://provider.example/o.png",
    outputHash: "h",
    capability: "flux-schnell",
    promptHash: "p",
    claimsUsed: [],
    derivedFrom: { sourceMediaId: "m", passportId: "p", productFactsId: "f" },
    generatedAt: "2026-09-21T00:00:00.000Z",
    visibility: "shared"
  } as unknown as DerivativeReceipt;

  it("receipt KA carries delivery identity only when stored", () => {
    const stored = receiptKa({
      ...baseReceipt,
      outputUrl: "https://res.cloudinary.com/demo/image/upload/asset",
      providerUrlFingerprint: "fp",
      storageProvider: "cloudinary",
      storagePublicId: "permitframe/ws/cmp/job",
      storageUrl: "https://res.cloudinary.com/demo/image/upload/asset",
      storageStatus: "stored"
    });
    assert.equal(stored.content["pf:deliveryUrl"], "https://res.cloudinary.com/demo/image/upload/asset");
    assert.equal(stored.content["pf:storagePublicId"], "permitframe/ws/cmp/job");
    assert.equal(stored.content["pf:outputUrl"], "https://res.cloudinary.com/demo/image/upload/asset");
    assert.equal(stored.content["pf:providerUrlFingerprint"], "fp");
    assert.ok(!("pf:outputHash" in stored.content), "URL fingerprints must never ship as outputHash");
    const legacy = receiptKa(baseReceipt);
    assert.ok(!("pf:deliveryUrl" in legacy.content));
    assert.ok(!("pf:storagePublicId" in legacy.content));
    assert.ok(!("pf:outputHash" in legacy.content));
    assert.equal(legacy.content["pf:providerUrlFingerprint"], "h", "legacy fingerprints map to the honest key");
  });

  it("public snapshots use the durable URL when stored", () => {
    const campaign = {
      id: "cmp_1",
      title: "T",
      brand: "B",
      productName: "P",
      request: { platform: "instagram", country: "GR" },
      status: "approved",
      preflight: { allowedClaims: [] },
      receipts: [{ ...baseReceipt, outputUrl: "https://res.cloudinary.com/demo/image/upload/asset" }],
      updatedAt: "2026-09-21T00:00:00.000Z"
    } as unknown as Campaign;
    const s = buildPublicSnapshot({ ref: "vrf_x", campaign, passport: null, facts: null });
    assert.equal(s.outputs[0].outputUrl, "https://res.cloudinary.com/demo/image/upload/asset");
  });
});

describe("idempotent persistence with bounded retries (neon)", () => {
  const JOB = `job_smoke_${Date.now().toString(36)}`;

  async function firstWorkspaceId(t: { skip: (msg?: string) => void }): Promise<string | null> {
    if (!process.env.DATABASE_URL) {
      t.skip("DATABASE_URL missing");
      return null;
    }
    const db = drizzle({ client: neon(process.env.DATABASE_URL), schema: { campaignAssets, workspaces } });
    const rows = await db.select({ id: workspaces.id }).from(workspaces).limit(1);
    if (!rows[0]) {
      t.skip("no workspace to attach smoke asset");
      return null;
    }
    return rows[0].id;
  }

  async function cleanup(): Promise<void> {
    restoreEnv();
    if (!process.env.DATABASE_URL) return;
    const db = drizzle({ client: neon(process.env.DATABASE_URL), schema: { campaignAssets, workspaces } });
    await db.delete(campaignAssets).where(eq(campaignAssets.jobId, JOB));
  }

  afterEach(cleanup);

  it("stored rows short-circuit; failures exhaust the budget", async (t) => {
    const ws = await firstWorkspaceId(t);
    if (!ws) return;
    let uploads = 0;
    __setCloudinaryUpload(async () => {
      uploads += 1;
      if (uploads < 3) throw new Error("boom: temporary outage");
      return { public_id: "p", version: 1, secure_url: "https://res.cloudinary.com/d/image/upload/p", resource_type: "image", format: "png", bytes: 10 };
    });
    const input = {
      workspaceId: ws,
      campaignId: "cmp_x",
      job: { id: JOB, kind: "text-to-image" as const, capability: "flux-schnell", providerOutputUrl: "https://cdn.example/o.png" },
      promptHash: "ph"
    };
    assert.equal((await persistJobAsset(input)).outcome, "failed");
    assert.equal((await persistJobAsset(input)).outcome, "failed");
    assert.equal((await persistJobAsset(input)).outcome, "stored");
    assert.equal(uploads, 3);
    const reuse = await persistJobAsset(input);
    assert.equal(reuse.outcome, "stored");
    assert.equal(uploads, 3, "stored assets must not re-upload");
    assert.equal(reuse.outcome === "stored" && reuse.asset.secureUrl, "https://res.cloudinary.com/d/image/upload/p");
  });

  it("expired provider URLs fail honestly with no false success", async (t) => {
    const ws = await firstWorkspaceId(t);
    if (!ws) return;
    __setCloudinaryUpload(async () => {
      throw new Error("410 Gone: the provider link expired before import");
    });
    const out = await persistJobAsset({
      workspaceId: ws,
      campaignId: "cmp_x",
      job: { id: JOB, kind: "text-to-image" as const, capability: "flux-schnell", providerOutputUrl: "https://cdn.example/expired.png" },
      promptHash: "ph"
    });
    assert.equal(out.outcome, "failed");
    assert.ok(out.outcome === "failed" && /expired/i.test(out.error), "failure names expiry so callers can direct to regeneration");
    assert.ok(out.outcome === "failed" && !/stored|delivered|success/i.test(out.error), "failure must never read as success");
  });

  it("unconfigured storage defers without touching the network", async (t) => {
    const ws = await firstWorkspaceId(t);
    if (!ws) return;
    setEnv("CLOUDINARY_CLOUD_NAME", undefined);
    setEnv("CLOUDINARY_API_KEY", undefined);
    setEnv("CLOUDINARY_API_SECRET", undefined);
    let uploads = 0;
    __setCloudinaryUpload(async () => {
      uploads += 1;
      return {};
    });
    const out = await persistJobAsset({
      workspaceId: ws,
      campaignId: "cmp_x",
      job: { id: JOB, kind: "text-to-image" as const, capability: "flux-schnell", providerOutputUrl: "https://cdn.example/o.png" },
      promptHash: "ph"
    });
    assert.equal(out.outcome, "deferred");
    assert.equal(uploads, 0);
  });
});
