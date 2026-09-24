import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import dotenv from "dotenv";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { sessions, users, workspaces, workspaceState } from "./db/schema";
import { SESSION_COOKIE } from "./auth";
import type { Database, SourceMedia } from "./types";
import { emptyDb } from "./store";
import { previewMimeForFormat } from "./source-upload";
import { PREVIEW_NOT_FOUND, PREVIEW_UNAVAILABLE, resolveConsentPreviewMediaId, resolvePreviewMedia, serveSourcePreview } from "./source-preview";

dotenv.config({ path: ".env.local" });

/**
 * Workspace-only source previews. No Cloudinary, Livepeer, or DKG calls:
 * the download URL and upstream fetch are injected fakes; the live route
 * tests below only exercise 401/404 paths (never a successful upstream
 * fetch) and skip without DATABASE_URL or a running dev server.
 */

const BASE = "http://localhost:3000";
const PUBLIC_ID = "src_abcdef123456";
const BYTE_HASH = "bytehashpreview00000000000000000000";
const TEMP_URL = "https://api.cloudinary.com/v1_1/demo/image/download?public_id=src_abcdef123456&signature=fakesig&api_key=fakekey&expires_at=9999999999";

function uploadImage(over: Partial<SourceMedia> = {}): SourceMedia {
  return {
    id: "med_preview",
    creatorId: "c1",
    title: "previewable upload",
    type: "image",
    url: `private:cloudinary:${PUBLIC_ID}`,
    hash: BYTE_HASH,
    source: "upload",
    storage: { provider: "cloudinary", publicId: PUBLIC_ID, resourceType: "image", format: "png", bytes: 16 },
    ...over
  };
}

function urlImage(): SourceMedia {
  return { id: "med_url", creatorId: "c1", title: "referenced", type: "image", url: "https://cdn.example/r.png", hash: "h" };
}

function dbWith(rows: SourceMedia[]): Database {
  const db = emptyDb();
  db.sourceMedia = rows;
  return db;
}

const BANNED = ["private:cloudinary", PUBLIC_ID, BYTE_HASH, "cloudinary", "fakesig", "fakekey", "api.cloudinary", "storage"];

describe("previewMimeForFormat", () => {
  it("maps stored formats, rejects unknown ones", () => {
    assert.equal(previewMimeForFormat("png"), "image/png");
    assert.equal(previewMimeForFormat("JPG"), "image/jpeg");
    assert.equal(previewMimeForFormat("jpeg"), "image/jpeg");
    assert.equal(previewMimeForFormat("gif"), "image/gif");
    assert.equal(previewMimeForFormat("webp"), "image/webp");
    assert.equal(previewMimeForFormat("mp4"), null);
    assert.equal(previewMimeForFormat(""), null);
    assert.equal(previewMimeForFormat(undefined), null);
  });
});

describe("resolvePreviewMedia", () => {
  it("resolves only complete image uploads", () => {
    const db = dbWith([uploadImage(), urlImage()]);
    assert.equal(resolvePreviewMedia(db, "med_preview")?.id, "med_preview");
    assert.equal(resolvePreviewMedia(db, "med_url"), null);
    assert.equal(resolvePreviewMedia(db, "nope"), null);
    assert.equal(resolvePreviewMedia(db, ""), null);
    assert.equal(resolvePreviewMedia(db, undefined), null);
  });

  it("rejects upload videos and malformed upload rows", () => {
    const db = dbWith([
      uploadImage({ id: "vid", type: "video" }),
      uploadImage({ id: "nostore", storage: undefined }),
      uploadImage({ id: "noformat", storage: { provider: "cloudinary", publicId: PUBLIC_ID, resourceType: "image", format: "", bytes: 1 } })
    ]);
    assert.equal(resolvePreviewMedia(db, "vid"), null);
    assert.equal(resolvePreviewMedia(db, "nostore"), null);
    assert.equal(resolvePreviewMedia(db, "noformat"), null);
  });
});

describe("resolveConsentPreviewMediaId", () => {
  const invite = {
    status: "pending" as const,
    linkExpiresAt: "2026-10-01",
    draft: { sourceMediaIds: ["med_preview", "med_url"] }
  };

  it("maps only an active consent link's opaque image position", () => {
    const db = dbWith([uploadImage(), urlImage()]);
    assert.equal(resolveConsentPreviewMediaId(db, invite, 0, "2026-09-24"), "med_preview");
    assert.equal(resolveConsentPreviewMediaId(db, invite, 1, "2026-09-24"), null);
    assert.equal(resolveConsentPreviewMediaId(db, invite, -1, "2026-09-24"), null);
  });

  it("refuses expired and completed links", () => {
    const db = dbWith([uploadImage()]);
    assert.equal(resolveConsentPreviewMediaId(db, { ...invite, linkExpiresAt: "2026-09-20" }, 0, "2026-09-24"), null);
    assert.equal(resolveConsentPreviewMediaId(db, { ...invite, status: "approved" }, 0, "2026-09-24"), null);
  });
});

describe("serveSourcePreview", () => {
  function fakes(body = "fake-png-bytes", contentType = "image/png", ok = true) {
    const calls: { download: unknown[]; fetched: unknown[] } = { download: [], fetched: [] };
    const deps = {
      downloadUrl: (input: unknown) => {
        calls.download.push(input);
        return TEMP_URL;
      },
      fetchImpl: (async (url: unknown) => {
        calls.fetched.push(String(url));
        return new Response(body, { status: ok ? 200 : 502, headers: { "content-type": contentType } });
      }) as typeof fetch
    };
    return { deps, calls };
  }

  it("streams upstream bytes with private no-store policy", async () => {
    const { deps, calls } = fakes();
    const result = await serveSourcePreview(dbWith([uploadImage()]), "med_preview", deps);
    assert.equal(result.status, 200);
    if (result.status !== 200) return;
    assert.equal(await result.response.text(), "fake-png-bytes");
    assert.equal(result.response.headers.get("content-type"), "image/png");
    assert.equal(result.response.headers.get("cache-control"), "private, no-store");
    assert.equal(result.response.headers.get("x-content-type-options"), "nosniff");
    // Temporary URL minted exactly once, fetched server-side, never returned.
    assert.equal(calls.download.length, 1);
    assert.deepEqual(calls.download[0], {
      publicId: PUBLIC_ID,
      format: "png",
      resourceType: "image"
    });
    assert.deepEqual(calls.fetched, [TEMP_URL]);
    const dump = JSON.stringify({ status: result.status, headers: Object.fromEntries(result.response.headers), body: "fake-png-bytes" });
    for (const banned of BANNED) assert.ok(!dump.includes(banned), `preview leaks: ${banned}`);
  });

  it("fails closed on upstream errors without leaking provider text", async () => {
    const bad = fakes("<?xml error>", "application/xml", false);
    const r1 = await serveSourcePreview(dbWith([uploadImage()]), "med_preview", bad.deps);
    assert.deepEqual(r1, { status: 503, error: PREVIEW_UNAVAILABLE });

    const wrongType = fakes("{}", "application/json");
    const r2 = await serveSourcePreview(dbWith([uploadImage()]), "med_preview", wrongType.deps);
    assert.deepEqual(r2, { status: 503, error: PREVIEW_UNAVAILABLE });

    const throwing = {
      downloadUrl: () => TEMP_URL,
      fetchImpl: (async () => {
        throw new Error(`fetch failed for ${TEMP_URL}`);
      }) as typeof fetch
    };
    const r3 = await serveSourcePreview(dbWith([uploadImage()]), "med_preview", throwing);
    assert.deepEqual(r3, { status: 503, error: PREVIEW_UNAVAILABLE });
    assert.ok(!JSON.stringify(r3).includes("fakesig"), "thrown provider text must not surface");
  });

  it("unknown rows never reach the download mechanism", async () => {
    const { deps, calls } = fakes();
    const r = await serveSourcePreview(dbWith([urlImage()]), "med_url", deps);
    assert.deepEqual(r, { status: 404, error: PREVIEW_NOT_FOUND });
    assert.equal(calls.download.length, 0);
    assert.equal(calls.fetched.length, 0);
  });
});

const WS_ID = "ws_test_source_preview";
const USER_ID = "usr_test_source_preview";
const PROBE_TOKEN = "preview-probe-token-0001";

function liveDb(): Database {
  const db = emptyDb();
  db.creators = [{ id: "c1", name: "Preview Creator", handle: "@preview" }];
  db.sourceMedia = [
    uploadImage(),
    urlImage(),
    uploadImage({ id: "med_vid", type: "video", title: "uploaded clip" })
  ];
  return db;
}

function liveDbClient() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
  return drizzle({ client: neon(process.env.DATABASE_URL), schema: { users, workspaces, workspaceState, sessions } });
}

async function serverUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/healthz`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}

describe("preview route auth and uniformity (live)", () => {
  let up = false;

  before(async () => {
    if (!process.env.DATABASE_URL) return;
    const d = liveDbClient();
    await d.insert(users).values({ id: USER_ID, displayName: "Preview Probe" }).onConflictDoNothing();
    await d.insert(workspaces).values({ id: WS_ID, ownerId: USER_ID, name: "Preview Probe" }).onConflictDoNothing();
    await d.insert(workspaceState).values({ workspaceId: WS_ID, data: liveDb() }).onConflictDoUpdate({
      target: workspaceState.workspaceId,
      set: { data: liveDb(), updatedAt: new Date() }
    });
    await d.insert(sessions).values({
      tokenHash: crypto.createHash("sha256").update(PROBE_TOKEN).digest("hex"),
      userId: USER_ID,
      workspaceId: WS_ID,
      expiresAt: new Date(Date.now() + 3600_000)
    }).onConflictDoNothing();
    up = await serverUp();
  });

  after(async () => {
    if (!process.env.DATABASE_URL) return;
    const d = liveDbClient();
    await d.delete(sessions).where(eq(sessions.workspaceId, WS_ID));
    await d.delete(workspaceState).where(eq(workspaceState.workspaceId, WS_ID));
    await d.delete(workspaces).where(eq(workspaces.id, WS_ID));
    await d.delete(users).where(eq(users.id, USER_ID));
  });

  const cookie = `${SESSION_COOKIE}=${PROBE_TOKEN}`;

  it("no session → 401 with the existing auth convention", async (t) => {
    if (!up) return t.skip("dev server not running");
    const r = await fetch(`${BASE}/api/media/med_preview/preview`);
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: "Authentication required" });
  });

  it("unknown, URL, and video ids share one indistinguishable 404", async (t) => {
    if (!up) return t.skip("dev server not running");
    const bodies: string[] = [];
    for (const id of ["med_missing", "med_url", "med_vid"]) {
      const r = await fetch(`${BASE}/api/media/${id}/preview`, { headers: { cookie } });
      assert.equal(r.status, 404, `expected 404 for ${id}`);
      bodies.push(JSON.stringify(await r.json()));
    }
    assert.equal(bodies[0], bodies[1]);
    assert.equal(bodies[1], bodies[2]);
    assert.deepEqual(JSON.parse(bodies[0]), { error: "Source media not found." });
    for (const banned of BANNED) assert.ok(!bodies.join("").includes(banned), `preview 404 leaks: ${banned}`);
  });
});
