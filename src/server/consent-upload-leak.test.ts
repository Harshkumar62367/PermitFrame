import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { users, workspaces, workspaceState } from "./db/schema";
import type { Database } from "./types";

dotenv.config({ path: ".env.local" });

const BASE = "http://localhost:3000";
const WS_ID = "ws_test_consent_upload_leak";
const USER_ID = "usr_test_consent_upload_leak";
const UPLOAD_TOKEN = "invite_uploadprobe01";
const URL_TOKEN = "invite_urlprobe0001";
const PUBLIC_ID = "src_abcdef123456";
const BYTE_HASH = "bytehashprobe0123456789abcdef";

/**
 * Anonymous consent-link leak probe: an uploaded private workspace copy
 * must never expose its controlled reference, Cloudinary public id, hash,
 * storage metadata, or delivery URL through the unauthenticated
 * /api/consent/[token] endpoint, while URL references keep their preview.
 * Live-server test (skipped without DATABASE_URL or a running dev server);
 * pure mapping is covered in consent-validation.test.ts.
 */
function seedDb(): Database {
  return {
    creators: [{ id: "crt_probe", name: "Probe Creator", handle: "@probe" }],
    passports: [],
    sourceMedia: [
      {
        id: "med_upload",
        creatorId: "crt_probe",
        title: "uploaded original",
        type: "image",
        url: `private:cloudinary:${PUBLIC_ID}`,
        hash: BYTE_HASH,
        source: "upload",
        storage: { provider: "cloudinary", publicId: PUBLIC_ID, resourceType: "image", format: "png", bytes: 13 }
      },
      {
        id: "med_url",
        creatorId: "crt_probe",
        title: "referenced original",
        type: "image",
        url: "https://cdn.example/probe.png",
        hash: "urlhash",
        source: "url"
      }
    ],
    productFacts: [],
    campaigns: [],
    consentInvites: [
      {
        token: UPLOAD_TOKEN,
        creatorId: "crt_probe",
        draft: {
          creatorId: "crt_probe",
          platforms: ["instagram"],
          countries: ["GR"],
          allowedTransformations: [],
          validUntil: "2027-03-01",
          sourceMediaIds: ["med_upload"]
        },
        status: "pending",
        purpose: "Leak probe",
        linkExpiresAt: "2027-04-01",
        createdAt: "2027-01-01T00:00:00.000Z",
        version: 1
      },
      {
        token: URL_TOKEN,
        creatorId: "crt_probe",
        draft: {
          creatorId: "crt_probe",
          platforms: ["instagram"],
          countries: ["GR"],
          allowedTransformations: [],
          validUntil: "2027-03-01",
          sourceMediaIds: ["med_url"]
        },
        status: "pending",
        purpose: "Leak probe",
        linkExpiresAt: "2027-04-01",
        createdAt: "2027-01-01T00:00:00.000Z",
        version: 1
      }
    ],
    events: [],
    idempotencyKeys: {},
    deletedCampaigns: []
  };
}

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
  return drizzle({ client: neon(process.env.DATABASE_URL), schema: { users, workspaces, workspaceState } });
}

async function serverUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/healthz`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}

describe("anonymous consent link upload leak", () => {
  let up = false;

  before(async () => {
    if (!process.env.DATABASE_URL) return;
    const d = db();
    await d.insert(users).values({ id: USER_ID, displayName: "Consent Leak Probe" }).onConflictDoNothing();
    await d.insert(workspaces).values({ id: WS_ID, ownerId: USER_ID, name: "Consent Leak Probe" }).onConflictDoNothing();
    await d.insert(workspaceState).values({ workspaceId: WS_ID, data: seedDb() }).onConflictDoUpdate({
      target: workspaceState.workspaceId,
      set: { data: seedDb(), updatedAt: new Date() }
    });
    up = await serverUp();
  });

  after(async () => {
    if (!process.env.DATABASE_URL) return;
    const d = db();
    await d.delete(workspaceState).where(eq(workspaceState.workspaceId, WS_ID));
    await d.delete(workspaces).where(eq(workspaces.id, WS_ID));
    await d.delete(users).where(eq(users.id, USER_ID));
  });

  it("upload media returns a flag and opaque request position, never an internal id or storage", async (t) => {
    if (!up) return t.skip("dev server not running");
    const r = await fetch(`${BASE}/api/consent/${UPLOAD_TOKEN}`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { media: Record<string, unknown>[] };
    assert.equal(body.media.length, 1);
    assert.deepEqual(body.media[0], { title: "uploaded original", type: "image", isPrivateUpload: true, previewIndex: 0 });
    const dump = JSON.stringify(body);
    for (const banned of ["private:cloudinary", "med_upload", PUBLIC_ID, BYTE_HASH, "cloudinary", "storage", "res.cloudinary", "http"]) {
      assert.ok(!dump.includes(banned), `consent API leaks: ${banned}`);
    }
  });

  it("URL media keeps its existing preview behavior", async (t) => {
    if (!up) return t.skip("dev server not running");
    const r = await fetch(`${BASE}/api/consent/${URL_TOKEN}`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { media: Record<string, unknown>[] };
    assert.deepEqual(body.media, [
      { title: "referenced original", type: "image", url: "https://cdn.example/probe.png", isPrivateUpload: false }
    ]);
  });
});
