import "server-only";
import { v2 as cloudinary } from "cloudinary";

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

let uploadImpl: UploadFn | null = null;

/** Test seam: mock the transport without touching the real SDK. */
export function __setCloudinaryUpload(fn: UploadFn | null): void {
  uploadImpl = fn;
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
