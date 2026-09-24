import crypto from "node:crypto";

/**
 * Pure validation for private source-media uploads. The bounded server
 * upload route inspects bytes directly, so classification never trusts the
 * browser-declared MIME type or filename alone: magic-byte sniffing is
 * authoritative, declared types must agree, and storage paths are always
 * server-generated. Unit-tested; no session, no I/O, no network.
 */

/** Hackathon-appropriate bounds: images stay light, video stays modest. */
export const UPLOAD_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const UPLOAD_VIDEO_MAX_BYTES = 25 * 1024 * 1024;
export const UPLOAD_TITLE_MAX = 80;

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
const VIDEO_MIMES = ["video/mp4", "video/webm", "video/quicktime"] as const;

export type SniffedKind = { kind: "image" | "video"; mime: string } | null;

/** Magic-byte sniffing. Returns null for unrecognized content. */
export function sniffMediaBytes(bytes: Uint8Array): SniffedKind {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: "image", mime: "image/jpeg" };
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { kind: "image", mime: "image/png" };
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    return { kind: "image", mime: "image/gif" };
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { kind: "image", mime: "image/webp" };
  }
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    // ISO-BMFF ftyp box: major brand "qt  " means QuickTime/MOV, anything else is treated as MP4.
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    return { kind: "video", mime: brand === "qt  " ? "video/quicktime" : "video/mp4" };
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { kind: "video", mime: "video/webm" };
  }
  return null;
}

export interface UploadFileInput {
  bytes?: unknown;
  mimeType?: unknown;
  filename?: unknown;
}

export interface ValidUpload {
  bytes: Uint8Array;
  kind: "image" | "video";
  mime: string;
  title: string;
}

/** Basename + safe characters only; never used as a storage path. */
export function sanitizeUploadTitle(filename: unknown, fallback: string): string {
  const raw = typeof filename === "string" ? filename : "";
  const base = raw.split(/[\\/]/).pop() ?? "";
  const withoutExt = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  const clean = withoutExt.replace(/[^A-Za-z0-9 _.\-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, UPLOAD_TITLE_MAX);
  return clean || fallback;
}

/** SHA-256 of the uploaded bytes (never of a URL string). */
export function sha256Bytes(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Stored delivery formats mapped to their bytes' MIME type. Unknown formats fail closed (no preview). */
const FORMAT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp"
};

/** MIME type for a stored upload format, or null when the format is unknown. */
export function previewMimeForFormat(format: unknown): string | null {
  if (typeof format !== "string") return null;
  return FORMAT_MIME[format.trim().toLowerCase()] ?? null;
}

export function validateUploadFile(
  input: UploadFileInput
): { ok: true; value: ValidUpload } | { ok: false; error: string } {
  const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
  if (!(input.bytes instanceof Uint8Array)) return fail("Choose a file to upload.");
  const bytes = input.bytes;
  if (bytes.length === 0) return fail("The selected file is empty - choose a file with content.");
  const sniffed = sniffMediaBytes(bytes);
  if (!sniffed) {
    return fail("Unsupported file type - upload a JPEG, PNG, GIF, or WebP image, or an MP4, WebM, or MOV video.");
  }
  const declared = typeof input.mimeType === "string" ? input.mimeType.toLowerCase().split(";")[0].trim() : "";
  const allowed: readonly string[] = sniffed.kind === "image" ? IMAGE_MIMES : VIDEO_MIMES;
  if (!allowed.includes(declared) || declared !== sniffed.mime) {
    return fail("File content does not match its declared type - re-export the file and try again.");
  }
  const max = sniffed.kind === "image" ? UPLOAD_IMAGE_MAX_BYTES : UPLOAD_VIDEO_MAX_BYTES;
  if (bytes.length > max) {
    return fail(
      sniffed.kind === "image"
        ? "Image is too large - images up to 10 MB can be uploaded."
        : "Video is too large - videos up to 25 MB can be uploaded."
    );
  }
  return {
    ok: true,
    value: {
      bytes,
      kind: sniffed.kind,
      mime: sniffed.mime,
      title: sanitizeUploadTitle(input.filename, "Uploaded source")
    }
  };
}
