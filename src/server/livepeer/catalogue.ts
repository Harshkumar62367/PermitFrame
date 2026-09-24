import { LivepeerMcpClient, livepeerConfig } from "./mcp-client";
import type { QualityProfile, StageRole } from "../types";
import { DEFAULT_QUALITY_PROFILE } from "./plan-dag";
import type { ModelOverrideRole } from "./template-catalogue";

/**
 * Small, reusable capability catalogue built ONLY from live Livepeer MCP
 * discovery. Nothing is claimed available unless the server reports
 * `availability === "available"` in the current fetch - preferences below
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

/**
 * Ordered role preferences per quality profile. Every name below was
 * verified `available` in live discovery (2026-09-21, 209 capabilities) -
 * but nothing is trusted blindly: a name is eligible only while the current
 * snapshot still reports it available, otherwise the next preference wins
 * and the substitution is recorded.
 *
 * flux-schnell appears ONLY in the draft concept list: it is the Draft
 * preview model, never a default final-quality model.
 */
const ROLE_PREFERENCE: Record<StageRole, Record<QualityProfile, string[]>> = {
  conceptImage: {
    draft: ["flux-schnell", "gemini-image"],
    balanced: ["flux-dev", "seedream-5-lite", "qwen-image-3-t2i", "gemini-image"],
    premium: ["flux-pro", "gpt-image", "ideogram-v4", "recraft-v4"]
  },
  // Source-guided variations share the concept eligibility ladder: same
  // models, different intent (guided by the approved source, never claimed
  // as exact preservation). The plan builder resolves them from the
  // conceptImage pick so siblings stay on one model per run.
  sourceGuidedImage: {
    draft: ["flux-schnell", "gemini-image"],
    balanced: ["flux-dev", "seedream-5-lite", "qwen-image-3-t2i", "gemini-image"],
    premium: ["flux-pro", "gpt-image", "ideogram-v4", "recraft-v4"]
  },
  // Subject-preserving stages prefer this eligibility ladder for the
  // guided fallback render. The place_subject tool itself dispatches only
  // through the preservation policy (eligible image stage + verified source
  // + live rights), with a recorded fallback to this ladder on any failure.
  subjectPreservingImage: {
    draft: ["nano-banana", "kontext-edit"],
    balanced: ["nano-banana", "kontext-edit"],
    premium: ["nano-banana", "kontext-edit"]
  },
  productPackshot: {
    draft: ["pixelcut-product-photo", "flux-pro", "flux-dev"],
    balanced: ["pixelcut-product-photo", "flux-pro", "flux-dev"],
    premium: ["pixelcut-product-photo", "flux-pro", "flux-dev"]
  },
  imageToVideo: {
    draft: ["ltx-25-i2v-fast", "pixverse-i2v", "seedance-mini-i2v"],
    balanced: ["kling-v3-turbo-i2v", "pixverse-i2v", "seedance-mini-i2v"],
    premium: ["kling-v3-turbo-pro-i2v", "seedance-i2v", "veo-i2v", "seedance-mini-i2v"]
  },
  upscale: {
    draft: ["topaz-upscale", "ccsr-upscale"],
    balanced: ["topaz-upscale", "ccsr-upscale"],
    premium: ["topaz-upscale", "ccsr-upscale"]
  },
  tts: {
    draft: ["chatterbox-tts", "inworld-tts", "grok-tts", "gemini-tts"],
    balanced: ["chatterbox-tts", "inworld-tts", "grok-tts", "gemini-tts"],
    premium: ["chatterbox-tts", "inworld-tts", "grok-tts", "gemini-tts"]
  },
  music: {
    draft: ["minimax-music-3", "music", "sonilo-v2m"],
    balanced: ["minimax-music-3", "music", "sonilo-v2m"],
    premium: ["minimax-music-3", "music", "sonilo-v2m"]
  },
  subtitle: {
    draft: ["nemotron-asr", "whisper-word"],
    balanced: ["nemotron-asr", "whisper-word"],
    premium: ["nemotron-asr", "whisper-word"]
  },
  // Critic is tool-backed (critique_shot / critique_batch, both verified in
  // tools/list) - resolved against the live tool list, never the capability
  // catalogue. No model names here by design.
  critic: {
    draft: [],
    balanced: [],
    premium: []
  }
};

/** Tool preference for the critic role (tool-backed, not a model). */
const CRITIC_TOOL_PREFERENCE = ["critique_batch", "critique_shot"];

/** Legacy env overrides (operator intent) - kept for the two image roles. */
const ROLE_ENV_OVERRIDE: Partial<Record<StageRole, string>> = {
  conceptImage: "LIVEPEER_IMAGE_CAPABILITY",
  imageToVideo: "LIVEPEER_VIDEO_CAPABILITY"
};

const CATALOGUE_TTL_MS = 10 * 60 * 1000;
let cached: { snapshot: CatalogueSnapshot; expiresAt: number } | null = null;
let pending: Promise<CatalogueSnapshot> | null = null;
let cachedTools: { tools: string[]; expiresAt: number } | null = null;
let pendingTools: Promise<string[]> | null = null;

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

/** Best-effort snapshot for UI/API surfaces - never throws, may be unreachable. */
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

export interface ResolvedRole {
  /** Model for create_media dispatch, or null for tool-backed / unresolvable roles. */
  capability: string | null;
  /** Tool name for tool-backed roles (critic), else null. */
  tool: string | null;
  source: "configured" | "discovered" | "default";
  /** "first-pick → actual" when availability forced an honest substitution. */
  fallbackFrom?: string;
}

/** Safe display data for one selectable model: name + short provider blurb only. */
export interface ModelChoice {
  name: string;
  description: string;
}

const MODEL_CHOICE_DESCRIPTION_MAX = 200;

/**
 * Model choices for an expert override, drawn ONLY from the current live
 * catalogue: the override key's verified role family (its in-code
 * eligibility ladder across all profiles - critic, preservation,
 * product-photo, upscale, and audio ladders are never included),
 * intersected with capabilities the snapshot reports available right now.
 * Returns safe display data only - never endpoints, auth mode, raw
 * payloads, internal model ids, or error text. No external documentation
 * list is consulted; models outside the verified family are offered only
 * through Automatic resolution, never as manual pins.
 */
export function modelChoicesForOverride(snapshot: CatalogueSnapshot, key: ModelOverrideRole): ModelChoice[] {
  if (!snapshot.reachable) return [];
  const available = new Set(
    snapshot.capabilities.filter((c) => c.availability === "available").map((c) => c.name)
  );
  const family: StageRole = key === "conceptImage" ? "conceptImage" : "imageToVideo";
  const names: string[] = [];
  for (const profile of ["draft", "balanced", "premium"] as QualityProfile[]) {
    for (const name of ROLE_PREFERENCE[family][profile]) {
      if (!names.includes(name)) names.push(name);
    }
  }
  const byName = new Map(snapshot.capabilities.map((c) => [c.name, c]));
  return names
    .filter((name) => available.has(name))
    .map((name) => ({
      name,
      description: (byName.get(name)?.description ?? "").trim().slice(0, MODEL_CHOICE_DESCRIPTION_MAX)
    }));
}

export interface RoleResolutionInput {
  /** Capability names the live catalogue reports as available right now. */
  available: Set<string>;
  /** Tool names from live tools/list (needed for the critic role). */
  tools?: string[];
}

/**
 * Resolve one role for one profile. Precedence: explicit env config
 * (operator intent, image roles only) → first currently-available
 * preference → verified default (list head, dispatch still gated by
 * assertCapabilityAvailable). A model is eligible only while live discovery
 * reports it available; substitutions are recorded in fallbackFrom.
 */
export function resolveRole(role: StageRole, profile: QualityProfile, input: RoleResolutionInput): ResolvedRole {
  if (role === "critic") {
    const tools = input.tools ?? [];
    const found = pick(new Set(tools), CRITIC_TOOL_PREFERENCE);
    if (found) {
      return {
        capability: null,
        tool: found,
        source: "discovered",
        ...(found !== CRITIC_TOOL_PREFERENCE[0]
          ? { fallbackFrom: `${CRITIC_TOOL_PREFERENCE[0]} → ${found}` }
          : {})
      };
    }
    return { capability: null, tool: null, source: "default" };
  }
  const envName = ROLE_ENV_OVERRIDE[role];
  const envValue = envName ? process.env[envName]?.trim() : undefined;
  if (envValue) return { capability: envValue, tool: null, source: "configured" };
  const prefs = ROLE_PREFERENCE[role][profile];
  const winner = pick(input.available, prefs);
  if (winner) {
    return {
      capability: winner,
      tool: null,
      source: "discovered",
      ...(winner !== prefs[0] ? { fallbackFrom: `${prefs[0]} → ${winner}` } : {})
    };
  }
  return { capability: prefs[0] ?? null, tool: null, source: "default" };
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
  const image = resolveRole("conceptImage", DEFAULT_QUALITY_PROFILE, { available });
  const motion = resolveRole("imageToVideo", DEFAULT_QUALITY_PROFILE, { available });
  return {
    image: image.source === "default" ? null : image.capability,
    motion: motion.source === "default" ? null : motion.capability
  };
}

/** Live tool names (tools/list), TTL-cached, never throwing. */
export async function fetchCreativeTools(): Promise<string[]> {
  if (cachedTools && cachedTools.expiresAt > Date.now()) return cachedTools.tools;
  if (!pendingTools) {
    pendingTools = new LivepeerMcpClient(livepeerConfig())
      .listTools()
      .then((tools) => {
        cachedTools = { tools, expiresAt: Date.now() + CATALOGUE_TTL_MS };
        return tools;
      })
      .catch(() => [])
      .finally(() => {
        pendingTools = null;
      });
  }
  return pendingTools;
}

export type ResolvedPlanRoles = Record<StageRole, ResolvedRole>;

/** Pure per-role resolution over one snapshot (+ tool list for critic). */
export function resolvePlanRolesFromSnapshot(
  profile: QualityProfile,
  snapshot: CatalogueSnapshot,
  tools: string[] = []
): ResolvedPlanRoles {
  const available = new Set(
    snapshot.reachable
      ? snapshot.capabilities.filter((c) => c.availability === "available").map((c) => c.name)
      : []
  );
  const input: RoleResolutionInput = { available, tools };
  return {
    conceptImage: resolveRole("conceptImage", profile, input),
    sourceGuidedImage: resolveRole("sourceGuidedImage", profile, input),
    subjectPreservingImage: resolveRole("subjectPreservingImage", profile, input),
    productPackshot: resolveRole("productPackshot", profile, input),
    imageToVideo: resolveRole("imageToVideo", profile, input),
    upscale: resolveRole("upscale", profile, input),
    tts: resolveRole("tts", profile, input),
    music: resolveRole("music", profile, input),
    subtitle: resolveRole("subtitle", profile, input),
    critic: resolveRole("critic", profile, input)
  };
}

/**
 * Resolve every role for a profile from live discovery. Discovery failure
 * never throws - roles fall back to verified defaults and dispatch-time
 * assertion keeps the failure honest.
 */
export async function resolvePlanRolesLive(profile: QualityProfile): Promise<ResolvedPlanRoles> {
  let snapshot: CatalogueSnapshot | null = null;
  try {
    snapshot = await fetchCapabilityCatalogue();
  } catch {
    snapshot = null;
  }
  const tools = await fetchCreativeTools();
  if (!snapshot) {
    const input: RoleResolutionInput = { available: new Set(), tools };
    return {
      conceptImage: resolveRole("conceptImage", profile, input),
      sourceGuidedImage: resolveRole("sourceGuidedImage", profile, input),
      subjectPreservingImage: resolveRole("subjectPreservingImage", profile, input),
      productPackshot: resolveRole("productPackshot", profile, input),
      imageToVideo: resolveRole("imageToVideo", profile, input),
      upscale: resolveRole("upscale", profile, input),
      tts: resolveRole("tts", profile, input),
      music: resolveRole("music", profile, input),
      subtitle: resolveRole("subtitle", profile, input),
      critic: resolveRole("critic", profile, input)
    };
  }
  return resolvePlanRolesFromSnapshot(profile, snapshot, tools);
}

/**
 * Resolve the concrete capabilities for a new production plan.
 * Precedence: explicit env config (operator intent) → live discovery pick →
 * verified default. The chosen names are persisted per job, and the studio's
 * Production details shows the exact capability each job actually ran.
 *
 * Legacy two-role entry point kept for existing callers; the balanced
 * profile drives it (flux-schnell is no longer a final-quality default).
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
    const roles = await resolvePlanRolesLive(DEFAULT_QUALITY_PROFILE);
    const image = envImage ?? roles.conceptImage.capability ?? ROLE_PREFERENCE.conceptImage[DEFAULT_QUALITY_PROFILE][0];
    const video = envVideo ?? roles.imageToVideo.capability ?? ROLE_PREFERENCE.imageToVideo[DEFAULT_QUALITY_PROFILE][0];
    const discovered = roles.conceptImage.source === "discovered" || roles.imageToVideo.source === "discovered";
    return {
      image,
      video,
      source: envImage || envVideo ? "configured" : discovered ? "discovered" : "default",
    };
  } catch {
    return {
      image: envImage ?? ROLE_PREFERENCE.conceptImage[DEFAULT_QUALITY_PROFILE][0],
      video: envVideo ?? ROLE_PREFERENCE.imageToVideo[DEFAULT_QUALITY_PROFILE][0],
      source: envImage || envVideo ? "configured" : "default"
    };
  }
}

/**
 * Refuse dispatch for capabilities the live catalogue does not report as
 * available. Throws an honest, retryable error naming the capability -
 * the pipeline surfaces it on the job instead of spending against a
 * missing model.
 */
export async function assertCapabilityAvailable(capability: string): Promise<void> {
  let snapshot: CatalogueSnapshot;
  try {
    snapshot = await fetchCapabilityCatalogue();
  } catch {
    return; // discovery unreachable: let the render attempt speak for itself
  }
  if (!snapshot.reachable) return;
  const available = new Set(
    snapshot.capabilities.filter((c) => c.availability === "available").map((c) => c.name)
  );
  if (!available.has(capability)) {
    throw new Error(
      `Capability "${capability}" is not currently available on the Creative surface - retry once it returns to discovery, or pick a listed model.`
    );
  }
}
