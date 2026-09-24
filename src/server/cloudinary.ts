import "server-only";
import { v2 as cloudinary } from "cloudinary";
import type { SourceMedia } from "./types";

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

export interface StoredAsset {
  publicId: string;
  version: number;
  secureUrl: string;
  resourceType: string;
  format: string;
  bytes: number;
  width?: number;
  height?: number;
  duration?: number;
  createdAt?: string;
}

/** Missing env names - values never appear in messages. */
export function missingCloudinaryEnv(): string[] {
  const missing: string[] = [];
  if (!process.env.CLOUDINARY_CLOUD_NAME?.trim()) missing.push("CLOUDINARY_CLOUD_NAME");
  if (!process.env.CLOUDINARY_API_KEY?.trim()) missing.push("CLOUDINARY_API_KEY");
  if (!process.env.CLOUDINARY_API_SECRET?.trim()) missing.push("CLOUDINARY_API_SECRET");
  return missing;
}

export function isCloudinaryConfigured(): boolean {
  return missingCloudinaryEnv().length === 0;
}

function readConfig(): CloudinaryConfig {
  const missing = missingCloudinaryEnv();
  if (missing.length > 0) {
    throw new Error(`Durable storage is not configured (missing ${missing.join(", ")}). Generation still works; assets stay provider-hosted.`);
  }
  return {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME as string,
    apiKey: process.env.CLOUDINARY_API_KEY as string,
    apiSecret: process.env.CLOUDINARY_API_SECRET as string
  };
}

export type UploadFn = (url: string, options: Record<string, unknown>) => Promise<Record<string, unknown>>;

export type UploadBytesFn = (bytes: Uint8Array, options: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface SourceDownloadInput {
  publicId: string;
  format: string;
  resourceType: "image" | "video";
  type: "authenticated";
  expiresAt: number;
}

export type SourceDownloadUrlFn = (
  publicId: string,
  format: string,
  options: { resource_type: string; type: string; expires_at: number; attachment: boolean }
) => string;

let uploadImpl: UploadFn | null = null;
let uploadBytesImpl: UploadBytesFn | null = null;
let sourceDownloadUrlImpl: SourceDownloadUrlFn | null = null;

/** Test seam: mock the transport without touching the real SDK. */
export function __setCloudinaryUpload(fn: UploadFn | null): void {
  uploadImpl = fn;
}

/** Test seam for byte uploads (private source copies). */
export function __setCloudinaryUploadBytes(fn: UploadBytesFn | null): void {
  uploadBytesImpl = fn;
}

/** Test seam for time-limited source download URLs (no Cloudinary calls). */
export function __setSourceDownloadUrl(fn: SourceDownloadUrlFn | null): void {
  sourceDownloadUrlImpl = fn;
}

function configuredCloudinary(): typeof cloudinary {
  const cfg = readConfig();
  cloudinary.config({ cloud_name: cfg.cloudName, api_key: cfg.apiKey, api_secret: cfg.apiSecret, secure: true });
  return cloudinary;
}

function mapResponse(res: Record<string, unknown>, fallbackType: string): StoredAsset {
  const resourceType = typeof res.resource_type === "string" ? res.resource_type : fallbackType;
  return {
    publicId: String(res.public_id ?? ""),
    version: typeof res.version === "number" ? res.version : 0,
    secureUrl: String(res.secure_url ?? ""),
    resourceType,
    format: typeof res.format === "string" ? res.format : "",
    bytes: typeof res.bytes === "number" ? res.bytes : 0,
    width: typeof res.width === "number" ? res.width : undefined,
    height: typeof res.height === "number" ? res.height : undefined,
    duration: typeof res.duration === "number" ? res.duration : undefined,
    createdAt: typeof res.created_at === "string" ? res.created_at : undefined
  };
}

/**
 * Import a remote HTTPS output into Cloudinary (server-side; the browser
 * never sees credentials). Deterministic public ID + `overwrite: false`
 * make retries idempotent: the same output reuses one asset.
 */
export async function uploadRemoteAsset(input: {
  sourceUrl: string;
  folder: string;
  publicId: string;
  resourceType: "image" | "video" | "auto";
}): Promise<StoredAsset> {
  if (!/^https:\/\//i.test(input.sourceUrl)) throw new Error("Only HTTPS provider URLs can be persisted.");
  const options: Record<string, unknown> = {
    folder: input.folder,
    public_id: input.publicId,
    resource_type: input.resourceType,
    overwrite: false,
    unique_filename: false,
    use_filename: false
  };
  let res: Record<string, unknown>;
  if (uploadImpl) {
    res = await uploadImpl(input.sourceUrl, options);
  } else {
    const api = configuredCloudinary();
    res = (await api.uploader.upload(input.sourceUrl, options)) as Record<string, unknown>;
  }
  const mapped = mapResponse(res, input.resourceType === "auto" ? "image" : input.resourceType);
  if (!mapped.publicId || !mapped.secureUrl) throw new Error("Cloudinary import returned an incomplete asset record.");
  return mapped;
}

/** Harmless account ping for health checks. Returns true when reachable. */
export async function pingCloudinary(): Promise<boolean> {
  try {
    if (uploadImpl) return true;
    const api = configuredCloudinary();
    const res = (await api.api.ping()) as Record<string, unknown>;
    return res?.status === "ok";
  } catch {
    return false;
  }
}

/** Delivery URL derivation without secrets (public id + cloud name only). */
export function deliveryUrlFor(publicId: string, resourceType: string, version?: number): string | null {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  if (!cloud || !publicId) return null;
  const kind = resourceType === "video" ? "video" : "image";
  const v = version ? `/v${version}` : "";
  return `https://res.cloudinary.com/${cloud}/${kind}/upload${v}/${publicId}`;
}

/* -------------------- private source copies (uploads) ------------------- */

/** Folder scope for one workspace's uploaded originals. Workspace id is server-resolved, never client input. */
export function sourceUploadFolder(workspaceId: string): string {
  const safe = workspaceId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "workspace";
  return `permitframe/sources/${safe}`;
}

/**
 * Store uploaded source bytes as a restricted-delivery Cloudinary asset.
 *
 * Delivery type "authenticated" (not "private"): the original AND every
 * derived/transformed variant requires a signed URL, so no unsigned
 * variant can become public. ("private" would leave transformed variants
 * addressable unless the Cloudinary account enables Strict
 * Transformations - an account-level setting this code cannot verify -
 * so it is deliberately not used.) The public id is server-generated;
 * the browser never chooses paths, folders, or visibility.
 */
export async function uploadPrivateSource(input: {
  bytes: Uint8Array;
  workspaceId: string;
  resourceType: "image" | "video";
  publicId: string;
}): Promise<{ publicId: string; bytes: number; format: string; resourceType: "image" | "video" }> {
  if (!/^src_[0-9a-f]{12}$/.test(input.publicId)) {
    throw new Error("Source upload requires a server-generated asset identity.");
  }
  const options: Record<string, unknown> = {
    folder: sourceUploadFolder(input.workspaceId),
    public_id: input.publicId,
    resource_type: input.resourceType,
    type: "authenticated",
    overwrite: false,
    unique_filename: false,
    use_filename: false
  };
  let res: Record<string, unknown>;
  if (uploadBytesImpl) {
    res = await uploadBytesImpl(input.bytes, options);
  } else {
    const api = configuredCloudinary();
    res = (await new Promise<Record<string, unknown>>((resolve, reject) => {
      const stream = api.uploader.upload_stream(options, (error, result) => {
        if (error) reject(error);
        else resolve((result ?? {}) as Record<string, unknown>);
      });
      stream.end(Buffer.from(input.bytes));
    })) as Record<string, unknown>;
  }
  const mapped = mapResponse(res, input.resourceType);
  // Format is mandatory downstream (the download endpoint needs it), so a
  // response without one is an incomplete storage result: reject before
  // any SourceMedia row can be created or persisted.
  if (!mapped.publicId || mapped.bytes <= 0 || !mapped.format) {
    throw new Error("Source upload did not produce a stored asset.");
  }
  return { publicId: mapped.publicId, bytes: mapped.bytes, format: mapped.format, resourceType: input.resourceType };
}

/**
 * Time-limited download URL for an authenticated source copy, via
 * Cloudinary's documented server-side download mechanism
 * (utils.private_download_url). The expiry timestamp is part of the
 * HMAC-signed payload, so Cloudinary enforces it: the URL stops working
 * after expires_at and cannot be extended by editing it. No network call -
 * pure local signing - but genuinely temporary, unlike a bare signed
 * delivery URL whose expiry is only a client-side claim.
 *
 * Handed only to the production service at generation time - never
 * persisted, never published, never rendered. The URL carries the public
 * api_key identifier the download endpoint requires, but never the API
 * secret. Requires Cloudinary configuration (fail closed otherwise).
 */
export function temporarySourceDownloadUrl(input: {
  publicId: string;
  format: string;
  resourceType: "image" | "video";
  expiresInSeconds?: number;
}): string {
  if (!input.publicId || !input.format) {
    throw new Error("Uploaded source has no stored copy - re-upload the file.");
  }
  configuredCloudinary();
  const expiresAt = Math.floor(Date.now() / 1000) + (input.expiresInSeconds ?? 3600);
  const options = {
    resource_type: input.resourceType,
    type: "authenticated",
    expires_at: expiresAt,
    attachment: false
  };
  const url = sourceDownloadUrlImpl
    ? sourceDownloadUrlImpl(input.publicId, input.format, options)
    : cloudinary.utils.private_download_url(input.publicId, input.format, options);
  if (!url || typeof url !== "string") {
    throw new Error("Private source delivery is not configured - uploads need Cloudinary storage.");
  }
  return url;
}

/**
 * The URL the production service may fetch for one source-media row.
 * URL registrations pass through unchanged. Uploads resolve to a
 * time-limited download URL (throws when storage is unconfigured or the
 * stored copy is incomplete - dispatch then fails closed instead of
 * sending a dead reference).
 */
export function resolveSourceMediaUrl(media: SourceMedia): string {
  if (media.source === "upload") {
    const storage = media.storage;
    if (!storage?.publicId || !storage.format) {
      throw new Error("Uploaded source has no stored copy - re-upload the file.");
    }
    return temporarySourceDownloadUrl({
      publicId: storage.publicId,
      format: storage.format,
      resourceType: storage.resourceType
    });
  }
  return media.url;
}
