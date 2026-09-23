/**
 * Read-only Creative MCP audio contract audit (observed 2026-09-23, no
 * paid calls, no dispatch). Records ONLY verified facts about five goal
 * operations: TTS narration, generated music, audio mixing, muxing audio
 * onto a final film, and soundtrack selection/export.
 *
 * Evidence tiers used below:
 * - "verified": read-only-observed live surface state (tools/list input
 *   schemas, list_capabilities availability, get_pricing rows). Field
 *   names, enums, required lists, and capability/pricing rows come from
 *   here. Availability and prices are point-in-time - re-resolve live
 *   before any dispatch (existing catalogue pattern).
 * - "partially_verified": schema-observed but unit-ambiguous, or
 *   corroborated only by the official livepeer/storyboard sources
 *   (create-media.ts action routing, licensed-sound skill, capability
 *   tables) without a live-schema statement.
 * - "unknown": would require a paid dispatch to observe (all provider
 *   response shapes), or was never stated anywhere (single-inference
 *   guarantees, exact music duration units).
 *
 * What was deliberately NOT inferred: `tracks_*` are exploration
 * branches (not audio tracks); `overlay.track` is a keyframed visual
 * path (not audio); `voice_*` are a name library (not synthesis).
 * Each is recorded in REJECTED_AUDIO_ASSUMPTIONS with its reason.
 *
 * This module dispatches nothing and is imported by nothing in
 * production - it is a decision record plus a dispatch gate for future
 * implementation work.
 */

export type AudioConfidence = "verified" | "partially_verified" | "unknown";

export type AudioOperation =
  | "tts_narration"
  | "music_bed"
  | "mix_tracks"
  | "mux_audio"
  | "soundtrack_export";

export interface AudioPriceRow {
  capability: string;
  usd: number | null;
  unit: string | null;
  /** get_pricing price_source at audit time (live rows can move). */
  source: string;
}

export interface AudioAsyncSemantics {
  /** Audio actions auto-enable async server-side (observed schema text). */
  autoAsync: boolean;
  statusTool: "get_create_media";
  idempotencyKey: boolean;
  preflightCapField: "max_cost_usd";
  costLedger: "get_cost_report";
}

export interface AudioOperationContract {
  operation: AudioOperation;
  /** Every verified audio op routes through create_media actions. */
  tool: "create_media" | null;
  action: "tts" | "music" | "mix_tracks" | "mux_audio" | null;
  requiredFields: string[];
  optionalFields: string[];
  async: AudioAsyncSemantics | null;
  prices: AudioPriceRow[];
  /** Verified TTS/music/mix/mux model or tool capabilities (available at audit). */
  capabilities: string[];
  /** Output kind per observed schema text (shapes themselves unobserved). */
  output: "audio_url" | "video_url" | "not_applicable" | "unknown";
  confidence: AudioConfidence;
  /** Exactly what is still unverified for this operation. */
  openQuestions: string[];
}

const CREATE_MEDIA_ASYNC: AudioAsyncSemantics = {
  autoAsync: true,
  statusTool: "get_create_media",
  idempotencyKey: true,
  preflightCapField: "max_cost_usd",
  costLedger: "get_cost_report"
};

const SHARED_COST_FIELDS = ["max_cost_usd", "idempotency_key", "session_id", "async"];

export const AUDIO_CONTRACTS: Record<AudioOperation, AudioOperationContract> = {
  tts_narration: {
    operation: "tts_narration",
    tool: "create_media",
    action: "tts",
    requiredFields: ["action", "prompt"],
    optionalFields: ["voice", "model_override", ...SHARED_COST_FIELDS],
    async: CREATE_MEDIA_ASYNC,
    prices: [
      { capability: "chatterbox-tts", usd: 0.02625, unit: "1000_characters", source: "static_fallback" },
      { capability: "inworld-tts", usd: 0.0105, unit: "1000_characters", source: "static_fallback" },
      { capability: "gemini-tts", usd: 0.1575, unit: "1000_characters", source: "static_fallback" },
      { capability: "grok-tts", usd: 0.01575, unit: "1000_characters", source: "static_fallback" }
    ],
    capabilities: ["chatterbox-tts", "inworld-tts", "gemini-tts", "grok-tts"],
    output: "audio_url",
    confidence: "verified",
    openQuestions: [
      "Provider response shape for action=tts (never dispatched - parse defensively).",
      "Per-call character ceiling (official source cites ~1500 chars; live schema states no max)."
    ]
  },
  music_bed: {
    operation: "music_bed",
    tool: "create_media",
    action: "music",
    requiredFields: ["action", "prompt", "duration"],
    optionalFields: ["lyrics_prompt", "instrumental", "model_override", ...SHARED_COST_FIELDS],
    async: CREATE_MEDIA_ASYNC,
    prices: [
      { capability: "music", usd: 0.0315, unit: "track", source: "static_fallback" },
      { capability: "minimax-music-3", usd: 0.0021, unit: "audio_seconds", source: "static_fallback" },
      { capability: "sonilo-t2m", usd: 0.00263, unit: "second", source: "static_fallback" },
      { capability: "sonilo-v2m", usd: 0.00945, unit: "second", source: "static_fallback" }
    ],
    capabilities: ["music", "minimax-music-3", "sonilo-t2m", "sonilo-v2m"],
    output: "audio_url",
    confidence: "verified",
    openQuestions: [
      "Provider response shape for action=music (never dispatched - parse defensively).",
      "Music `duration` unit/range: the live `duration` field is video-framed (integer 3-15) while the action text requires a duration and caps render 60s+ tracks - unit unconfirmed.",
      "Licensed vs unlicensed bed choice (sonilo licensed per official skill; minimax for internal) is a product decision, not a contract fact."
    ]
  },
  mix_tracks: {
    operation: "mix_tracks",
    tool: "create_media",
    action: "mix_tracks",
    requiredFields: ["action", "tracks"],
    optionalFields: ["model_override", ...SHARED_COST_FIELDS],
    async: CREATE_MEDIA_ASYNC,
    prices: [{ capability: "ffmpeg-audio-mix", usd: 0, unit: "call", source: "live" }],
    capabilities: ["ffmpeg-audio-mix"],
    output: "audio_url",
    confidence: "verified",
    openQuestions: ["Provider response shape for action=mix_tracks (never dispatched - parse defensively)."]
  },
  mux_audio: {
    operation: "mux_audio",
    tool: "create_media",
    action: "mux_audio",
    requiredFields: ["action", "source_url", "audio_url"],
    optionalFields: ["audio_fill", "model_override", ...SHARED_COST_FIELDS],
    async: CREATE_MEDIA_ASYNC,
    prices: [{ capability: "ffmpeg-mux", usd: 0, unit: "call", source: "live" }],
    capabilities: ["ffmpeg-mux"],
    output: "video_url",
    confidence: "verified",
    openQuestions: ["Provider response shape for action=mux_audio (never dispatched - parse defensively)."]
  },
  soundtrack_export: {
    operation: "soundtrack_export",
    tool: null,
    action: null,
    requiredFields: [],
    optionalFields: [],
    async: null,
    prices: [],
    capabilities: [],
    output: "unknown",
    confidence: "partially_verified",
    openQuestions: [
      "director_export soundtrack auto/off is schema-verified but requires proj_* project ids - PermitFrame film runs are cjob_* creative jobs, so no verified export verb applies to our reels.",
      "assemble music-bed composition is schema-verified but likewise project-based (clips[] in, proj_* out).",
      "The implementable composition (music bed + mux_audio onto the cjob reel) is covered by the verified music_bed/mux_audio contracts above; a standalone soundtrack export needs a provider-confirmed cjob export verb."
    ]
  }
};

/**
 * Field-name traps that must never become dispatch assumptions. Each was
 * observed and explicitly ruled out by its schema description.
 */
export const REJECTED_AUDIO_ASSUMPTIONS: { name: string; reason: string }[] = [
  {
    name: "tracks_new/tracks_promote/tracks_list",
    reason: "Exploration branches (child projects), not audio tracks - use create_media action=mix_tracks `tracks` instead."
  },
  {
    name: "overlay.track/track_sidecar_url/track_class",
    reason: "Keyframed visual overlay path (subject-tracked PiP), not audio - overlay composites logos/text only."
  },
  {
    name: "voice_create/voice_list/voice_attach as synthesis",
    reason: "A named vocal-sample library (bookkeeping); synthesis itself is create_media action=tts, and auto-injection into TTS is an explicitly pending follow-up per the schema."
  },
  {
    name: "chatterbox voice clone via audio_url on create_media",
    reason: "The observed tts schema carries `voice` (voice id), not audio_url - clone-by-URL wiring is unconfirmed on this surface."
  },
  {
    name: "director_export/assemble for cjob film reels",
    reason: "Both require proj_* project ids; our reels are cjob_* creative jobs with no verified project bridge."
  }
];

/** Unknown operation names can never reach dispatch through this gate. */
export function audioContractFor(operation: string): AudioOperationContract {
  const contract = (AUDIO_CONTRACTS as Record<string, AudioOperationContract>)[operation];
  if (!contract) {
    throw new Error(
      `Unknown audio operation "${operation}" - no verified provider contract exists. Refusing to dispatch.`
    );
  }
  return contract;
}

/**
 * Dispatch gate for future audio work: only fully verified operations
 * pass. Partially verified (soundtrack_export) and unknown names throw -
 * callers must resolve the listed open questions first.
 */
export function assertAudioDispatchable(operation: string): AudioOperationContract {
  const contract = audioContractFor(operation);
  if (contract.confidence !== "verified" || !contract.tool || !contract.action) {
    throw new Error(
      `Audio operation "${operation}" is ${contract.confidence} - not dispatchable. ` +
        `Open: ${contract.openQuestions[0] ?? "no verified contract"}.`
    );
  }
  return contract;
}
