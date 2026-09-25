import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Campaign, Database, PermissionPassport, ProductFacts, SourceMedia } from "./types";
import { emptyDb } from "./store";
import {
  UPLOAD_IMAGE_MAX_BYTES,
  UPLOAD_VIDEO_MAX_BYTES,
  sanitizeUploadTitle,
  sha256Bytes,
  sniffMediaBytes,
  validateUploadFile
} from "./source-upload";
import { isPrivateUpload, mediaTileKind, uploadReference } from "./types";
import {
  __setCloudinaryUploadBytes,
  __setSourceDownloadUrl,
  resolveSourceMediaUrl,
  sourceUploadFolder,
  temporarySourceDownloadUrl,
  uploadPrivateSource
} from "./cloudinary";
import { sourceMediaKa } from "./dkg/schemas";
import { isSafePublicDomainError, sanitizeDkgError } from "./dkg/public-errors";
import { checkAuthorizationBinding, type AuthorizationEvidence } from "./policy/authorization";
import { buildWorkspaceOverview } from "./overview";

/**
 * Private source-media uploads. No Cloudinary, Livepeer, or DKG requests:
 * byte uploads and download-URL generation run through injected seams
 * (the real-SDK shape assertion below builds URLs offline with a fake
 * secret and makes no network calls), and DKG publishing is never invoked
 * (only serialization is asserted).
 */

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3, 4, 5, 6, 7]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1]);
const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1]);
const mov = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 1]);
const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

function uploadMedia(over: Partial<SourceMedia> = {}): SourceMedia {
  return {
    id: "med_up",
    creatorId: "c1",
    title: "Uploaded source",
    type: "image",
    url: uploadReference("src_abcdef123456"),
    hash: "bytehash",
    source: "upload",
    storage: { provider: "cloudinary", publicId: "src_abcdef123456", resourceType: "image", format: "png", bytes: 13 },
    ...over
  };
}

describe("sniffMediaBytes", () => {
  it("identifies supported images and video by magic bytes", () => {
    assert.deepEqual(sniffMediaBytes(png), { kind: "image", mime: "image/png" });
    assert.deepEqual(sniffMediaBytes(jpeg), { kind: "image", mime: "image/jpeg" });
    assert.deepEqual(sniffMediaBytes(gif), { kind: "image", mime: "image/gif" });
    assert.deepEqual(sniffMediaBytes(webp), { kind: "image", mime: "image/webp" });
    assert.deepEqual(sniffMediaBytes(mp4), { kind: "video", mime: "video/mp4" });
    assert.deepEqual(sniffMediaBytes(mov), { kind: "video", mime: "video/quicktime" });
    assert.deepEqual(sniffMediaBytes(webm), { kind: "video", mime: "video/webm" });
  });

  it("rejects garbage and truncated input", () => {
    assert.equal(sniffMediaBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])), null);
    assert.equal(sniffMediaBytes(new Uint8Array([0xff, 0xd8])), null);
    assert.equal(sniffMediaBytes(new Uint8Array([])), null);
  });
});

describe("validateUploadFile", () => {
  it("rejects missing, empty, and unsupported files", () => {
    assert.deepEqual(validateUploadFile({}), { ok: false, error: "Choose a file to upload." });
    assert.deepEqual(validateUploadFile({ bytes: new Uint8Array([]), mimeType: "image/png" }), {
      ok: false,
      error: "The selected file is empty - choose a file with content."
    });
    const r = validateUploadFile({ bytes: new Uint8Array(16).fill(7), mimeType: "application/pdf" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Unsupported file type/);
  });

  it("rejects oversized images and video", () => {
    const bigImage = new Uint8Array(UPLOAD_IMAGE_MAX_BYTES + 1);
    bigImage.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ri = validateUploadFile({ bytes: bigImage, mimeType: "image/png" });
    assert.deepEqual(ri, { ok: false, error: "Image is too large - images up to 10 MB can be uploaded." });
    const bigVideo = new Uint8Array(UPLOAD_VIDEO_MAX_BYTES + 1);
    bigVideo.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const rv = validateUploadFile({ bytes: bigVideo, mimeType: "video/mp4" });
    assert.deepEqual(rv, { ok: false, error: "Video is too large - videos up to 25 MB can be uploaded." });
  });

  it("rejects declared types that disagree with the bytes", () => {
    const r = validateUploadFile({ bytes: png, mimeType: "video/mp4" });
    assert.deepEqual(r, {
      ok: false,
      error: "File content does not match its declared type - re-export the file and try again."
    });
  });

  it("accepts valid files and sanitizes hostile filenames", () => {
    const r = validateUploadFile({ bytes: png, mimeType: "image/png", filename: "../../etc/passwd.png" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.kind, "image");
    assert.equal(r.value.title, "passwd");
    const titled = validateUploadFile({ bytes: mov, mimeType: "video/quicktime", filename: "clip.mov" });
    assert.equal(titled.ok, true);
    if (!titled.ok) return;
    assert.equal(titled.value.kind, "video");
    assert.equal(titled.value.title, "clip");
  });

  it("sanitizeUploadTitle falls back safely", () => {
    assert.equal(sanitizeUploadTitle("   ", "Uploaded source"), "Uploaded source");
    assert.equal(sanitizeUploadTitle(undefined, "Uploaded source"), "Uploaded source");
    assert.equal(sanitizeUploadTitle("C:\\fakepath\\shot.PNG", "x"), "shot");
  });
});

describe("hashing and classification", () => {
  it("hashes bytes, not URLs", () => {
    assert.equal(sha256Bytes(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("marks uploads private and builds non-routable references", () => {
    assert.equal(isPrivateUpload(uploadMedia()), true);
    assert.equal(isPrivateUpload({ source: "url" }), false);
    assert.equal(isPrivateUpload({}), false);
    assert.equal(uploadReference("src_abcdef123456"), "private:cloudinary:src_abcdef123456");
  });

  it("mediaTileKind routes uploads to private and preserves URL previews", () => {
    // Matrix shared by the signed-in surfaces (media grid, consent picker
    // and thumbs, campaign header): uploads never qualify for direct
    // preview, URL rows keep their existing image/video rendering.
    assert.equal(mediaTileKind({ source: "upload", type: "image" }), "private");
    assert.equal(mediaTileKind({ source: "upload", type: "video" }), "private");
    assert.equal(mediaTileKind({ source: "url", type: "image" }), "image");
    assert.equal(mediaTileKind({ source: "url", type: "video" }), "video");
    assert.equal(mediaTileKind({ type: "image" }), "image");
  });
});

describe("cloudinary private-source adapter (seamed, no network)", () => {
  const saved = {
    cloud: process.env.CLOUDINARY_CLOUD_NAME,
    key: process.env.CLOUDINARY_API_KEY,
    secret: process.env.CLOUDINARY_API_SECRET
  };
  afterEach(() => {
    __setCloudinaryUploadBytes(null);
    __setSourceDownloadUrl(null);
    if (saved.cloud === undefined) delete process.env.CLOUDINARY_CLOUD_NAME;
    else process.env.CLOUDINARY_CLOUD_NAME = saved.cloud;
    if (saved.key === undefined) delete process.env.CLOUDINARY_API_KEY;
    else process.env.CLOUDINARY_API_KEY = saved.key;
    if (saved.secret === undefined) delete process.env.CLOUDINARY_API_SECRET;
    else process.env.CLOUDINARY_API_SECRET = saved.secret;
  });

  function fakeEnv() {
    process.env.CLOUDINARY_CLOUD_NAME = "demo";
    process.env.CLOUDINARY_API_KEY = "key";
    process.env.CLOUDINARY_API_SECRET = "secret-value-that-must-never-leak";
  }

  it("constrains folder, public id, authenticated type, and resource type server-side", async () => {
    fakeEnv();
    let seen: Record<string, unknown> = {};
    __setCloudinaryUploadBytes(async (bytes, options) => {
      seen = options;
      assert.ok(bytes.length > 0);
      return { public_id: "src_abcdef123456", bytes: bytes.length, format: "png", resource_type: "image" };
    });
    const out = await uploadPrivateSource({
      bytes: png,
      workspaceId: "ws_test",
      resourceType: "image",
      publicId: "src_abcdef123456"
    });
    assert.deepEqual(out, { publicId: "src_abcdef123456", bytes: png.length, format: "png", resourceType: "image" });
    assert.equal(seen.folder, "permitframe/sources/ws_test");
    assert.equal(seen.public_id, "src_abcdef123456");
    assert.equal(seen.type, "authenticated");
    assert.equal(seen.resource_type, "image");
    assert.equal(seen.overwrite, false);
  });

  it("rejects non-server public ids and incomplete responses", async () => {
    fakeEnv();
    __setCloudinaryUploadBytes(async () => ({ public_id: "x", bytes: 1 }));
    await assert.rejects(
      uploadPrivateSource({ bytes: png, workspaceId: "ws", resourceType: "image", publicId: "../../evil" }),
      /server-generated asset identity/
    );
    __setCloudinaryUploadBytes(async () => ({ public_id: "", bytes: 0 }));
    await assert.rejects(
      uploadPrivateSource({ bytes: png, workspaceId: "ws", resourceType: "image", publicId: "src_abcdef123456" }),
      /did not produce a stored asset/
    );
  });

  it("rejects a response with missing format before any row can persist", async () => {
    fakeEnv();
    // Otherwise valid: known public id, positive bytes - but no delivery
    // format, which the download endpoint mandates. Must fail with the
    // same safe storage error, so registerUploadedSourceMedia never runs.
    __setCloudinaryUploadBytes(async () => ({ public_id: "src_abcdef123456", bytes: 128, format: "" }));
    await assert.rejects(
      uploadPrivateSource({ bytes: png, workspaceId: "ws", resourceType: "image", publicId: "src_abcdef123456" }),
      /did not produce a stored asset/
    );
    __setCloudinaryUploadBytes(async () => ({ public_id: "src_abcdef123456", bytes: 128 }));
    await assert.rejects(
      uploadPrivateSource({ bytes: png, workspaceId: "ws", resourceType: "image", publicId: "src_abcdef123456" }),
      /did not produce a stored asset/
    );
  });

  it("passes public id, format, type, and one-hour expiry to the download mechanism", () => {
    fakeEnv();
    let seen: { publicId?: string; format?: string; options?: Record<string, unknown> } = {};
    __setSourceDownloadUrl((publicId, format, options) => {
      seen = { publicId, format, options };
      return `https://download.example/t?expires_at=${String(options.expires_at)}`;
    });
    const before = Math.floor(Date.now() / 1000);
    const url = temporarySourceDownloadUrl({ publicId: "src_abcdef123456", format: "png", resourceType: "image" });
    assert.equal(seen.publicId, "src_abcdef123456");
    assert.equal(seen.format, "png");
    assert.equal(seen.options?.resource_type, "image");
    assert.equal(seen.options?.type, "authenticated");
    const expiresAt = Number(seen.options?.expires_at);
    assert.ok(expiresAt >= before + 3590 && expiresAt <= before + 3600, `one-hour expiry, got ${expiresAt}`);
    assert.equal(url, `https://download.example/t?expires_at=${expiresAt}`);
  });

  it("the real SDK download URL is temporary and carries no secret", () => {
    fakeEnv();
    __setSourceDownloadUrl(null);
    const before = Math.floor(Date.now() / 1000);
    const url = temporarySourceDownloadUrl({ publicId: "src_abcdef123456", format: "png", resourceType: "image" });
    assert.match(url, /^https:\/\/api\.cloudinary\.com\/v1_1\/demo\/image\/download\?/);
    assert.match(url, /public_id=src_abcdef123456/);
    assert.match(url, /type=authenticated/);
    assert.match(url, /signature=[0-9a-f]{40}/);
    const expiresAt = Number(new URL(url).searchParams.get("expires_at"));
    assert.ok(expiresAt >= before + 3590 && expiresAt <= before + 3600, `server-enforced one-hour expiry, got ${expiresAt}`);
    assert.ok(!url.includes("secret-value-that-must-never-leak"));
  });

  it("fails closed without storage configuration", () => {
    delete process.env.CLOUDINARY_CLOUD_NAME;
    delete process.env.CLOUDINARY_API_KEY;
    delete process.env.CLOUDINARY_API_SECRET;
    assert.throws(
      () => temporarySourceDownloadUrl({ publicId: "src_abcdef123456", format: "png", resourceType: "image" }),
      /not configured|required/i
    );
  });

  it("resolveSourceMediaUrl passes URLs through and mints download URLs for uploads", () => {
    fakeEnv();
    __setSourceDownloadUrl((publicId, format, options) => `https://download.example/t/${publicId}.${format}?e=${String(options.expires_at)}`);
    assert.equal(
      resolveSourceMediaUrl({ source: "url", url: "https://source.example/a.png", type: "image" } as SourceMedia),
      "https://source.example/a.png"
    );
    const before = Math.floor(Date.now() / 1000);
    const resolved = resolveSourceMediaUrl(uploadMedia());
    assert.match(resolved, /^https:\/\/download\.example\/t\/src_abcdef123456\.png\?e=\d+$/);
    const expiresAt = Number(resolved.split("?e=")[1]);
    assert.ok(expiresAt >= before + 3590 && expiresAt <= before + 3600);
    assert.throws(() => resolveSourceMediaUrl(uploadMedia({ storage: undefined })), /no stored copy/);
  });

  it("sourceUploadFolder strips hostile workspace input", () => {
    assert.equal(sourceUploadFolder("ws_abc123"), "permitframe/sources/ws_abc123");
    assert.equal(sourceUploadFolder("../../x"), "permitframe/sources/x");
  });
});

describe("DKG serialization excludes upload internals", () => {
  it("upload records carry classification and hash, never reference internals", () => {
    const ka = sourceMediaKa(uploadMedia());
    const dump = JSON.stringify(ka.content);
    assert.equal(ka.content["pf:storageClass"], "private-workspace-copy");
    assert.equal(ka.content["pf:referenceFingerprint"], "bytehash");
    assert.equal("pf:referenceUrl" in ka.content, false);
    assert.ok(!dump.includes("private:cloudinary"));
    assert.ok(!dump.includes("src_abcdef123456"));
    assert.ok(!dump.includes("cloudinary"));
    assert.equal(ka.content["pf:visibility"], "private");
  });

  it("URL records keep their exact existing shape", () => {
    const ka = sourceMediaKa({
      id: "m1",
      creatorId: "c1",
      title: "t",
      type: "image",
      url: "https://source.example/a.png",
      hash: "h"
    });
    assert.equal(ka.content["pf:referenceUrl"], "https://source.example/a.png");
    assert.equal("pf:storageClass" in ka.content, false);
  });
});

describe("upload error copy stays user-visible", () => {
  const messages = [
    "Choose a file to upload.",
    "Could not read the uploaded file - try again.",
    "The selected file is empty - choose a file with content.",
    "Unsupported file type - upload a JPEG, PNG, GIF, or WebP image, or an MP4, WebM, or MOV video.",
    "File content does not match its declared type - re-export the file and try again.",
    "Image is too large - images up to 10 MB can be uploaded.",
    "Video is too large - videos up to 25 MB can be uploaded.",
    "Upload is too large - images up to 10 MB and videos up to 25 MB can be uploaded.",
    "Upload storage is not configured - ask the workspace owner to connect durable storage first."
  ];
  for (const message of messages) {
    it(`passes the sanitizer allowlist: ${message.slice(0, 36)}…`, () => {
      assert.equal(isSafePublicDomainError(message, "workspace"), true);
      const safe = sanitizeDkgError(new Error(message), "workspace");
      assert.equal(safe.message, message);
      assert.equal(safe.status, 400);
    });
  }
});

describe("authorization still binds uploaded media to its creator", () => {
  function evidence(media: SourceMedia): AuthorizationEvidence {
    const passport: PermissionPassport = {
      id: "pp_selected",
      creatorId: "c1",
      creatorName: "Creator",
      sourceMediaIds: ["med_up"],
      platforms: ["instagram"],
      countries: ["GR"],
      allowedTransformations: ["edit"],
      validFrom: "2026-01-01",
      validUntil: "2027-01-01",
      status: "active",
      attestation: { method: "creator-consent-link", consentedAt: "2026-01-01", declaration: "ok" },
      visibility: "public"
    };
    const facts: ProductFacts = {
      id: "f1",
      brand: "Verdi",
      productName: "TerraRunner",
      approvedClaims: [],
      prohibitedClaims: [],
      guidelines: [],
      evidenceNotes: "e",
      visibility: "shared"
    };
    return {
      campaign: {
        id: "cmp_up",
        creatorId: "c1",
        sourceMediaId: "med_up",
        passportId: "pp_selected",
        productFactsId: "f1",
        brand: "Verdi",
        productName: "TerraRunner",
        request: {
          platform: "instagram",
          country: "GR",
          requestedClaims: [],
          transformation: "image",
          creativeBrief: "A sufficiently long creative brief."
        }
      },
      media,
      facts,
      passport,
      liveReachable: false,
      today: "2026-09-24"
    };
  }

  it("an upload bound to the selected creator succeeds", () => {
    assert.equal(checkAuthorizationBinding(evidence(uploadMedia())).ok, true);
  });

  it("an upload from another creator still blocks", () => {
    const r = checkAuthorizationBinding(evidence(uploadMedia({ creatorId: "c2" })));
    assert.equal(r.ok, false);
  });
});

describe("workspace overview uses safe upload previews", () => {
  function dbWith(media: SourceMedia): Database {
    const db = emptyDb();
    db.sourceMedia = [media];
    db.campaigns = [
      {
        id: "cmp_ov",
        title: "Overview probe",
        status: "draft",
        request: {
          platform: "instagram",
          country: "GR",
          requestedClaims: [],
          transformation: "image",
          creativeBrief: "A sufficiently long creative brief."
        },
        brand: "Verdi",
        productName: "TerraRunner",
        creatorId: "c1",
        sourceMediaId: media.id,
        passportId: "pp1",
        productFactsId: "f1",
        contextNote: "",
        updatedAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        comments: [],
        captions: [],
        receipts: [],
        jobs: []
      } as Campaign
    ];
    return db;
  }

  it("renders an image upload through the same-origin preview route", () => {
    const view = buildWorkspaceOverview(dbWith(uploadMedia()), "ws", []);
    assert.equal(view.campaigns[0].thumbnailUrl, "/api/media/med_up/preview");
  });

  it("URL media still renders as the thumbnail", () => {
    const view = buildWorkspaceOverview(
      dbWith({ id: "m1", creatorId: "c1", title: "t", type: "image", url: "https://source.example/a.png", hash: "h" }),
      "ws",
      []
    );
    assert.equal(view.campaigns[0].thumbnailUrl, "https://source.example/a.png");
  });
});
