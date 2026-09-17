import { LivepeerMcpClient, livepeerConfig } from "./mcp-client";

/**
 * Small, reusable capability catalogue built ONLY from live Livepeer MCP
 * discovery. Nothing is claimed available unless the server reports
 * `availability === "available"` in the current fetch — preferences below
 * are just an ordering over reported names.
 */

export interface CataloguedCapability {
  name: string;
  kind: string;
  availability: string;
  modelId: string;
  description: string;
}

export interface CatalogueSnapshot {
  reachable: boolean;
  authMode: "bearer-key" | "keyless-hosted";
  totalReported: number;
  checkedAt: string;
  capabilities: CataloguedCapability[];
}

export interface PlanRoles {
  /** Text-to-image capability for keyframe + variations (with source URL). */
  image: string | null;
  /** Image-to-video capability for the motion asset. */
  motion: string | null;
}

/** Preference order for the hero still / keyframe (all verified via discovery). */
const IMAGE_PREFERENCE = [
  "flux-schnell",
  "flux-dev",
  "gpt-image",
  "uni-1-t2i",
  "qwen-image-3-t2i",
  "grok-image-2",
  "mai-image-2.5"
];

/** Preference order for the motion asset (all verified via discovery). */
const MOTION_PREFERENCE = [
  "seedance-mini-i2v",
  "seedance-i2v",
  "pixverse-i2v",
  "kling-v3-turbo-i2v",
  "ltx-25-i2v-fast",
  "veo-i2v",
  "minimax-h3-i2v"
];

const FALLBACK_IMAGE = "flux-schnell";
const FALLBACK_MOTION = "seedance-mini-i2v";

const CATALOGUE_TTL_MS = 10 * 60 * 1000;
let cached: { snapshot: CatalogueSnapshot; expiresAt: number } | null = null;
let pending: Promise<CatalogueSnapshot> | null = null;

function normalize(raw: unknown): CataloguedCapability[] {
  const list = (raw as { capabilities?: unknown })?.capabilities;
  if (!Array.isArray(list)) return [];
  return list
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    .map((c) => ({
      name: typeof c.name === "string" ? c.name : "",
      kind: typeof c.kind === "string" ? c.kind : "",
      availability: typeof c.availability === "string" ? c.availability : "",
      modelId: typeof c.model_id === "string" ? c.model_id : "",
      description: typeof c.description === "string" ? c.description : ""
    }))
    .filter((c) => c.name.length > 0);
}

async function fetchFresh(): Promise<CatalogueSnapshot> {
  const config = livepeerConfig();
  const client = new LivepeerMcpClient(config);
  const raw = await client.listCapabilities();
  const capabilities = normalize(raw);
  const total =
    typeof (raw as { total?: unknown }).total === "number"
      ? (raw as { total: number }).total
      : capabilities.length;
  return {
    reachable: true,
    authMode: config.bearer ? "bearer-key" : "keyless-hosted",
    totalReported: total,
    checkedAt: new Date().toISOString(),
    capabilities
  };
}

/** Live catalogue with TTL cache. Throws when the MCP server is unreachable. */
export async function fetchCapabilityCatalogue(): Promise<CatalogueSnapshot> {
  if (cached && cached.expiresAt > Date.now()) return cached.snapshot;
  if (!pending) {
    pending = fetchFresh()
      .then((snapshot) => {
        cached = { snapshot, expiresAt: Date.now() + CATALOGUE_TTL_MS };
        return snapshot;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

/** Best-effort snapshot for UI/API surfaces — never throws, may be unreachable. */
export async function catalogueSnapshot(): Promise<CatalogueSnapshot> {
  try {
    return await fetchCapabilityCatalogue();
  } catch {
    if (cached) return cached.snapshot;
    const config = livepeerConfig();
    return {
      reachable: false,
      authMode: config.bearer ? "bearer-key" : "keyless-hosted",
      totalReported: 0,
      checkedAt: new Date().toISOString(),
      capabilities: []
    };
  }
}

function pick(available: Set<string>, preference: string[]): string | null {
  for (const name of preference) {
    if (available.has(name)) return name;
  }
  return null;
}

/**
 * Map discovered capabilities to plan roles. Only names the server reported
 * as available are ever returned; null means "no verified pick" and callers
 * fall back to explicit env config or long-standing defaults.
 */
export function roleCapabilities(snapshot: CatalogueSnapshot): PlanRoles {
  if (!snapshot.reachable) return { image: null, motion: null };
  const available = new Set(
    snapshot.capabilities.filter((c) => c.availability === "available").map((c) => c.name)
  );
  return {
    image: pick(available, IMAGE_PREFERENCE),
    motion: pick(available, MOTION_PREFERENCE)
  };
}

/**
 * Resolve the concrete capabilities for a new production plan.
 * Precedence: explicit env config (operator intent) → live discovery pick →
 * verified default. The chosen names are persisted per job, and the studio's
 * Production details shows the exact capability each job actually ran.
 */
export async function resolvePlanCapabilities(): Promise<{
  image: string;
  video: string;
  source: "configured" | "discovered" | "default";
}> {
  const envImage = process.env.LIVEPEER_IMAGE_CAPABILITY?.trim();
  const envVideo = process.env.LIVEPEER_VIDEO_CAPABILITY?.trim();
  if (envImage && envVideo) return { image: envImage, video: envVideo, source: "configured" };
  try {
    const roles = roleCapabilities(await fetchCapabilityCatalogue());
    return {
      image: envImage ?? roles.image ?? FALLBACK_IMAGE,
      video: envVideo ?? roles.motion ?? FALLBACK_MOTION,
      source: envImage || envVideo ? "configured" : roles.image || roles.motion ? "discovered" : "default",
    };
  } catch {
    return {
      image: envImage ?? FALLBACK_IMAGE,
      video: envVideo ?? FALLBACK_MOTION,
      source: envImage || envVideo ? "configured" : "default"
    };
  }
}
