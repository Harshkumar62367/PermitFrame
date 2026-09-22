import crypto from "node:crypto";
import type { QualityProfile } from "../types";
import { redactSecrets } from "../dkg/edge-node-adapter";
import {
  buildCreativeConfirmArgs,
  parseCreativeStatus,
  parseCreativeSubmit,
  type CreativeStatusParsed,
  type CreativeSubmitArgs,
  type CreativeSubmitParsed
} from "./film-job";

/**
 * Minimal MCP (streamable HTTP) client for the Livepeer Agent Creative
 * surface (registered-hackathon endpoint). Pattern proven by the official
 * hackathon example app: JSON-RPC 2.0 POSTs, mcp-session-id capture.
 *
 * Renders dispatch through `create_media` (the Creative surface does not
 * expose `run_capability`); async jobs are polled with `get_create_media`.
 * Bearer tokens travel only in the Authorization header - never in errors,
 * logs, or persisted records (see redactSecrets).
 */

export interface LivepeerConfig {
  endpoint: string;
  bearer?: string;
}

export function livepeerConfig(): LivepeerConfig {
  return {
    endpoint: process.env.LIVEPEER_MCP_URL ?? "https://agent.livepeer.org/api/mcp/creative",
    bearer: process.env.LIVEPEER_MCP_BEARER || undefined
  };
}

export interface CapabilityRunResult {
  outputUrl?: string;
  raw: Record<string, unknown>;
  humanSummary?: string;
  capability?: string;
  requestedCapability?: string;
  modelNote?: string;
  jobId?: string;
  costUsd?: number;
  status: string;
}

export interface AsyncSubmitResult {
  /** Provider job id - absent when the call completed inline with an output. */
  jobId?: string;
  /** Inline terminal output (fast models completing synchronously). */
  outputUrl?: string;
  status: string;
  costUsd?: number;
  capability?: string;
  raw: Record<string, unknown>;
}

export interface MediaStatusResult {
  status: string;
  terminal: boolean;
  outputUrl?: string;
  jobId?: string;
  costUsd?: number;
  capability?: string;
  raw: Record<string, unknown>;
}

  export interface VariationResult {
  outputUrls: string[];
  /** Async provider handle when the tool backgrounds the job (no inline output). */
  jobId?: string;
  costUsd?: number;
  capability?: string;
  raw: Record<string, unknown>;
}

export interface QualityCritique {
  score: number | null;
  passed: boolean;
  note: string;
}

export class LivepeerMcpClient {
  private sessionId?: string;
  private initialized = false;

  constructor(private readonly config: LivepeerConfig) {}

  private async callJsonRpc(
    method: string,
    params: Record<string, unknown>,
    transportTimeoutMs = 120_000
  ): Promise<Record<string, unknown>> {
    const response = await fetch(this.config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...(this.config.bearer ? { authorization: `Bearer ${this.config.bearer}` } : {})
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
      signal: AbortSignal.timeout(transportTimeoutMs)
    });
    this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Livepeer MCP request failed (${response.status}): ${text.slice(0, 300)}`);
    }
    // streamable HTTP may answer with SSE frames; extract the data payload
    if (text.startsWith("event:") || text.includes("data:")) {
      const dataLines = text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      const last = dataLines.at(-1);
      if (last) return JSON.parse(last) as Record<string, unknown>;
    }
    return JSON.parse(text) as Record<string, unknown>;
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const payload = await this.callJsonRpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "permitframe", version: "0.1.0" }
    });
    if (payload.error) throw new Error(`Livepeer MCP initialization failed: ${JSON.stringify(payload.error)}`);
    // streamable HTTP requires the initialized notification before tool calls
    try {
      await this.callJsonRpc("notifications/initialized", {});
    } catch {
      // notifications expect no response; some servers return 202, tolerate both
    }
    this.initialized = true;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    transportTimeoutMs = 120_000
  ): Promise<Record<string, unknown>> {
    await this.ensureInitialized();
    return this.callJsonRpc("tools/call", { name, arguments: args }, transportTimeoutMs);
  }

  async listCapabilities(): Promise<Record<string, unknown>> {
    const payload = await this.callTool("list_capabilities", {});
    assertToolOk(payload, "list_capabilities");
    return structured(payload);
  }

  async getPricing(): Promise<Record<string, unknown>> {
    const payload = await this.callTool("get_pricing", {});
    assertToolOk(payload, "get_pricing");
    return structured(payload);
  }

  async getCostReport(): Promise<Record<string, unknown>> {
    const payload = await this.callTool("get_cost_report", {});
    assertToolOk(payload, "get_cost_report");
    return structured(payload);
  }

  /**
   * Live MCP tool names (protocol-level tools/list). Read-only discovery -
   * no spend, no side effects. Used to resolve tool-backed roles (critic).
   * Returns [] when the surface does not answer.
   */
  async listTools(): Promise<string[]> {
    await this.ensureInitialized();
    const payload = await this.callJsonRpc("tools/list", {});
    if (payload.error) return [];
    const tools = (payload.result as { tools?: unknown })?.tools;
    if (!Array.isArray(tools)) return [];
    return tools
      .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
      .map((t) => t.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
  }

  /**
   * Run a capability through the Creative surface (`create_media`).
   * Stable internal contract kept for the pipeline: capability/prompt/
   * source/ids in, parsed outcome out. Action selection is deliberate -
   * image-to-video (and upscale) need a source image (`animate`/`upscale`
   * with `source_url`); everything else renders via `generate` with the
   * selected capability as `model_override`. Jobs render inline
   * (async: false); if the server backgrounds the job anyway, we poll
   * get_create_media. Nothing is fabricated: missing outputs, ids, status,
   * costs, or model names surface as errors, never guesses.
   */
  async runCapability(input: {
    capability: string;
    kind?: "text-to-image" | "image-to-image" | "image-to-video" | "upscale" | "audio-to-text";
    prompt?: string;
    sourceUrl?: string;
    inputs?: Record<string, unknown>;
    timeoutSeconds?: number;
    sessionId?: string;
    idempotencyKey?: string;
    maxCostUsd?: number;
    /**
     * Requested quality profile. Fast-path rendering (prefer_fast) is a
     * Draft-preview tradeoff: sent ONLY for draft. Balanced and premium
     * omit it entirely so the surface renders at full quality.
     */
    qualityProfile?: QualityProfile;
  }): Promise<CapabilityRunResult> {
    const action = actionFor(input.kind, input.sourceUrl);
    const timeout = Math.min(Math.max(input.timeoutSeconds ?? 60, 10), 900);
    const aspectRatio = typeof input.inputs?.aspect_ratio === "string" ? (input.inputs.aspect_ratio as string) : undefined;
    const duration =
      typeof input.inputs?.duration === "number"
        ? (input.inputs.duration as number)
        : action === "animate"
          ? 5
          : undefined;
    let payload = await this.callTool(
      "create_media",
      {
        action,
        ...(input.prompt ? { prompt: input.prompt } : {}),
        model_override: input.capability,
        ...(input.sourceUrl ? { source_url: input.sourceUrl } : {}),
        ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
        ...(duration !== undefined ? { duration } : {}),
        async: false,
        persist: false,
        ...(input.maxCostUsd !== undefined ? { max_cost_usd: input.maxCostUsd } : {}),
        // Draft previews trade quality for speed; final-quality profiles
        // must never fast-path. The flag is omitted (not false) otherwise.
        ...(action === "generate" && input.qualityProfile === "draft" ? { prefer_fast: true } : {}),
        session_id: input.sessionId ? `permitframe_${sanitize(input.sessionId)}` : "permitframe",
        ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {})
      },
      timeout * 1000 + 30_000
    );
    assertToolOk(payload, `create_media(${action}, ${input.capability})`);

    let jobId = extractJobId(payload);
    if (isFailed(extractStatus(payload))) {
      throw new Error(`Livepeer job failed: ${resultText(payload).slice(0, 300)}`);
    }
    if (extractReference(payload)) {
      return finalize(payload, jobId, input.capability);
    }
    if (!jobId) {
      throw new Error(`Livepeer returned no output and no job id: ${resultText(payload).slice(0, 300)}`);
    }

    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      await delay(5000);
      payload = await this.callTool("get_create_media", { job_id: jobId });
      assertToolOk(payload, "get_create_media");
      jobId = extractJobId(payload) ?? jobId;
      if (isFailed(extractStatus(payload))) {
        throw new Error(`Livepeer job failed: ${resultText(payload).slice(0, 300)}`);
      }
      if (extractReference(payload)) return finalize(payload, jobId, input.capability);
    }
    throw new Error(`Livepeer job timed out after ${timeout}s`);
  }

  /**
   * Async submit: create_media with async:true returns a provider job id
   * immediately (mjob_*) without holding the call open. The id is persisted
   * before any polling so retries poll instead of re-submitting (no
   * duplicate paid jobs). Same idempotency_key contract as the sync path.
   */
  async submitMedia(input: {
    capability: string;
    kind?: "text-to-image" | "image-to-image" | "image-to-video" | "upscale" | "audio-to-text";
    prompt?: string;
    sourceUrl?: string;
    inputs?: Record<string, unknown>;
    maxCostUsd?: number;
    qualityProfile?: QualityProfile;
    sessionId?: string;
    idempotencyKey?: string;
  }): Promise<AsyncSubmitResult> {
    const action = actionFor(input.kind, input.sourceUrl);
    const aspectRatio = typeof input.inputs?.aspect_ratio === "string" ? (input.inputs.aspect_ratio as string) : undefined;
    const duration = typeof input.inputs?.duration === "number" ? (input.inputs.duration as number) : action === "animate" ? 5 : undefined;
    const payload = await this.callTool(
      "create_media",
      {
        action,
        ...(input.prompt ? { prompt: input.prompt } : {}),
        model_override: input.capability,
        ...(input.sourceUrl ? { source_url: input.sourceUrl } : {}),
        ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
        ...(duration !== undefined ? { duration } : {}),
        async: true,
        persist: false,
        ...(input.maxCostUsd !== undefined ? { max_cost_usd: input.maxCostUsd } : {}),
        ...(action === "generate" && input.qualityProfile === "draft" ? { prefer_fast: true } : {}),
        session_id: input.sessionId ? `permitframe_${sanitize(input.sessionId)}` : "permitframe",
        ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {})
      },
      120_000
    );
    assertToolOk(payload, `create_media(${action}, ${input.capability})`);
    if (isFailed(extractStatus(payload))) {
      throw new Error(`Livepeer job failed: ${resultText(payload).slice(0, 300)}`);
    }
    // Fast models may complete inline: carry the terminal output (plus any
    // reported cost/model) so callers finalize without a provider id.
    const s = structured(payload) as Record<string, unknown>;
    const inline = extractReference(payload);
    const jobId = extractJobId(payload);
    if (!jobId && !inline) {
      throw new Error(`Livepeer returned no output and no job id: ${resultText(payload).slice(0, 300)}`);
    }
    return {
      ...(jobId ? { jobId } : {}),
      ...(inline ? { outputUrl: inline } : {}),
      status: extractStatus(payload) || "unknown",
      costUsd: num(s.cost_paid_usd ?? s.cost_usd_estimated ?? s.cost_usd ?? s.total_cost_usd),
      capability: str(s.capability ?? s.capability_used ?? s.model ?? s.model_used),
      raw: s
    };
  }

  /** Poll the status endpoint for one async job (resume-safe, no side effects). */
  async getMediaStatus(jobId: string): Promise<MediaStatusResult> {
    const payload = await this.callTool("get_create_media", { job_id: jobId });
    assertToolOk(payload, "get_create_media");
    const status = extractStatus(payload) || "unknown";
    const s = structured(payload) as Record<string, unknown>;
    return {
      status,
      terminal: isTerminal(status),
      outputUrl: extractReference(payload),
      jobId: extractJobId(payload) ?? jobId,
      costUsd: num(s.cost_paid_usd ?? s.cost_usd_estimated ?? s.cost_usd ?? s.total_cost_usd),
      capability: str(s.capability ?? s.capability_used ?? s.model ?? s.model_used),
      raw: s
    };
  }

  /**
   * Hold one call open up to budgetSeconds for provider-side progress
   * (mjob_* ids). Returns the latest status snapshot; non-terminal means
   * "still running, poll again". Failures of the progress call itself
   * throw so callers fall back to a direct status poll.
   */
  async waitForProgress(jobId: string, budgetSeconds = 25): Promise<MediaStatusResult> {
    const payload = await this.callTool(
      "subscribe_progress",
      { job_id: jobId, budget_seconds: Math.min(Math.max(budgetSeconds, 1), 25) },
      budgetSeconds * 1000 + 10_000
    );
    assertToolOk(payload, "subscribe_progress");
    const status = extractStatus(payload) || "unknown";
    const s = structured(payload) as Record<string, unknown>;
    return {
      status,
      terminal: isTerminal(status),
      outputUrl: extractReference(payload),
      jobId: extractJobId(payload) ?? jobId,
      costUsd: num(s.cost_paid_usd ?? s.cost_usd_estimated ?? s.cost_usd ?? s.total_cost_usd),
      capability: str(s.capability ?? s.capability_used ?? s.model ?? s.model_used),
      raw: s
    };
  }

  /**
   * Subject-preserving multi-scene render (place_subject). Schema validated
   * read-only against tools/list. Returns the first output URL; callers
   * fall back to create_media when the call fails or yields nothing usable.
   */
  async placeSubject(input: {
    sourceUrl: string;
    scenes: string[];
    subjectHint?: string;
    modelOverride?: string;
    maxCostUsd?: number;
    sessionId?: string;
    idempotencyKey?: string;
  }): Promise<{ outputUrls: string[]; jobId?: string; costUsd?: number; capability?: string; raw: Record<string, unknown> }> {
    const payload = await this.callTool(
      "place_subject",
      {
        source_url: input.sourceUrl,
        scenes: input.scenes,
        count: input.scenes.length,
        ...(input.subjectHint ? { subject_hint: input.subjectHint } : {}),
        ...(input.modelOverride ? { model_override: input.modelOverride } : {}),
        ...(input.maxCostUsd !== undefined ? { max_cost_usd: input.maxCostUsd } : {}),
        session_id: input.sessionId ? `permitframe_${sanitize(input.sessionId)}` : "permitframe",
        ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {})
      },
      300_000
    );
    assertToolOk(payload, "place_subject");
    const s = structured(payload) as Record<string, unknown>;
    const placeJobId = extractJobId(payload);
    return {
      outputUrls: extractReferences(payload),
      ...(placeJobId ? { jobId: placeJobId } : {}),
      costUsd: num(s.cost_paid_usd ?? s.cost_usd_estimated ?? s.cost_usd ?? s.total_cost_usd),
      capability: str(s.capability ?? s.capability_used ?? s.model ?? s.model_used),
      raw: structured(payload)
    };
  }

  /**
   * Controlled alternatives of an existing image (revise flow): seed/prompt/
   * model variations without re-typing the brief. Requires source_url.
   */
  async createVariations(input: {
    sourceUrl: string;
    prompt?: string;
    mode?: "seed" | "prompt" | "model";
    count?: number;
    modelOverrides?: string[];
    maxCostUsd?: number;
    sessionId?: string;
    idempotencyKey?: string;
  }): Promise<VariationResult> {
    const payload = await this.callTool(
      "create_variations",
      {
        source_url: input.sourceUrl,
        ...(input.prompt ? { prompt: input.prompt } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.count !== undefined ? { count: input.count } : {}),
        ...(input.modelOverrides ? { model_overrides: input.modelOverrides } : {}),
        ...(input.maxCostUsd !== undefined ? { max_cost_usd: input.maxCostUsd } : {}),
        session_id: input.sessionId ? `permitframe_${sanitize(input.sessionId)}` : "permitframe",
        ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {})
      },
      300_000
    );
    assertToolOk(payload, "create_variations");
    const s = structured(payload) as Record<string, unknown>;
    const varyJobId = extractJobId(payload);
    return {
      outputUrls: extractReferences(payload),
      ...(varyJobId ? { jobId: varyJobId } : {}),
      costUsd: num(s.cost_paid_usd ?? s.cost_usd_estimated ?? s.cost_usd ?? s.total_cost_usd),
      capability: str(s.capability ?? s.capability_used ?? s.model ?? s.model_used),
      raw: structured(payload)
    };
  }

  /**
   * Campaign Film submit (submit_creative_job): returns immediately with a
   * provider job id (or a staged/awaiting-confirmation gate, or a
   * budget_exceeded refusal). A non-empty provider id is tracked, never
   * treated as completion. Callers persist the id before any poll/confirm
   * so retries never submit a second paid job. Args carry only confirmed
   * film fields (title, scenes, target, aspect, deliver reel, budget cap,
   * stable session tag) - no auto_plan, soundtrack, music, or model picks.
   */
  async submitCreativeJob(args: CreativeSubmitArgs): Promise<CreativeSubmitParsed> {
    const payload = await this.callTool("submit_creative_job", { ...args }, 120_000);
    assertToolOk(payload, "submit_creative_job");
    return parseCreativeSubmit(payload);
  }

  /**
   * Campaign Film execute mode: approve a job the cost-confirm gate staged.
   * Only called after the user confirmed the plan + budget cap and the
   * provider estimate fits inside it. Parsed like a submit (the provider
   * may return the dispatched state or re-stage).
   */
  async confirmCreativeJob(providerJobId: string): Promise<CreativeSubmitParsed> {
    const payload = await this.callTool("submit_creative_job", buildCreativeConfirmArgs(providerJobId), 120_000);
    assertToolOk(payload, "submit_creative_job(confirm)");
    return parseCreativeSubmit(payload);
  }

  /**
   * Campaign Film status (get_creative_job): per-scene progress plus the
   * final reel URL. Read-only and free - safe for resume polling. Shapes
   * are defensive (submit/get responses are unobserved): unknown payloads
   * parse to non-terminal snapshots, never guesses.
   */
  async getCreativeJob(jobId: string): Promise<CreativeStatusParsed> {
    const payload = await this.callTool("get_creative_job", { job_id: jobId }, 60_000);
    assertToolOk(payload, "get_creative_job");
    return parseCreativeStatus(payload);
  }

  /**
   * Campaign Film cancel (cancel_creative_job): stops the worker picking up
   * new scenes; already-dispatched renders complete naturally. Returns
   * whether the provider confirmed - callers must not claim success
   * otherwise, and never touch unrelated campaign assets.
   *
   * Cancellation notes are stable user-safe strings only: raw provider
   * text, transport errors, and payload fragments never reach the public
   * note or the persisted run record - the raw cause goes exclusively
   * through the redacted server log below.
   */
  async cancelCreativeJob(jobId: string): Promise<{ cancelled: boolean; note: string }> {
    let payload: Record<string, unknown>;
    try {
      payload = await this.callTool("cancel_creative_job", { job_id: jobId });
    } catch (e) {
      console.error(
        "[livepeer-mcp:cancel_creative_job]",
        redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 500)
      );
      return { cancelled: false, note: "Provider cancel request failed before confirmation." };
    }
    const text = resultText(payload).toLowerCase();
    const status = extractStatus(payload);
    const confirmed =
      !payload.error &&
      !(payload.result as { isError?: boolean } | undefined)?.isError &&
      (status === "cancelled" || status === "canceled" || text.includes("cancelled") || text.includes("canceled"));
    if (!confirmed) {
      console.error(
        "[livepeer-mcp:cancel_creative_job]",
        redactSecrets(resultText(payload)).slice(0, 500)
      );
    }
    return {
      cancelled: confirmed,
      note: confirmed ? "Provider confirmed cancellation." : "Provider did not confirm cancellation."
    };
  }

  /**
   * Best-effort provider cancellation for async media and creative jobs.
   * Returns whether the provider confirmed it - callers must not claim
   * success otherwise.
   *
   * Cancellation notes are stable user-safe strings only: raw provider
   * text and transport errors never reach the public note - the raw cause
   * goes exclusively through the redacted server log below.
   */
  async cancelProviderJob(jobId: string): Promise<{ cancelled: boolean; note: string }> {
    let payload: Record<string, unknown>;
    try {
      payload = await this.callTool("cancel_job", { job_id: jobId });
    } catch (e) {
      console.error(
        "[livepeer-mcp:cancel_job]",
        redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 500)
      );
      return { cancelled: false, note: "Provider cancel request failed before confirmation." };
    }
    const text = resultText(payload).toLowerCase();
    const status = extractStatus(payload);
    const confirmed =
      !payload.error &&
      !(payload.result as { isError?: boolean } | undefined)?.isError &&
      (status === "cancelled" || text.includes("cancelled") || text.includes("canceled"));
    if (!confirmed) {
      console.error(
        "[livepeer-mcp:cancel_job]",
        redactSecrets(resultText(payload)).slice(0, 500)
      );
    }
    return {
      cancelled: confirmed,
      note: confirmed ? "Provider confirmed cancellation." : "Provider did not confirm cancellation."
    };
  }

  /**
   * Advisory vision grade of a generated scene vs a reference (approved
   * source). Never throws for scoring issues - unparseable responses yield
   * score null, and callers must never fail a stage on critique alone.
   */
  async critiqueShot(input: {
    generatedUrl: string;
    referenceUrl: string;
    entityName?: string;
    threshold?: number;
  }): Promise<QualityCritique> {
    const threshold = input.threshold ?? 0.7;
    const payload = await this.callTool("critique_shot", {
      generated_url: input.generatedUrl,
      reference_url: input.referenceUrl,
      ...(input.entityName ? { entity_name: input.entityName } : {}),
      threshold
    });
    assertToolOk(payload, "critique_shot");
    const s = structured(payload) as Record<string, unknown>;
    const score =
      num(s.weighted_total ?? s.total ?? s.score) ??
      num((s.sub_scores as Record<string, unknown> | undefined)?.weighted_total) ??
      null;
    return {
      score,
      passed: score === null ? true : score >= threshold,
      note:
        str(s.pass_fail ?? s.verdict) ??
        (score === null ? "Critique returned no parseable score - treated as advisory pass." : `Vision score ${score.toFixed(2)} vs threshold ${threshold}.`)
    };
  }
}

/**
 * Deliberate action selection for `create_media`. Animate/upscale transform
 * an existing image, so they require a source URL - without one the call
 * would fail server-side after spending, so we refuse locally instead.
 */
export function actionFor(
  kind: "text-to-image" | "image-to-image" | "image-to-video" | "upscale" | "audio-to-text" | undefined,
  sourceUrl: string | undefined
): "generate" | "animate" | "upscale" {
  if (kind === "image-to-video") {
    if (!sourceUrl) throw new Error("Image-to-video needs a source image - nothing to animate without one.");
    return "animate";
  }
  if (kind === "upscale") {
    if (!sourceUrl) throw new Error("Upscale needs a source image - nothing to upscale without one.");
    return "upscale";
  }
  if (kind === "audio-to-text") {
    throw new Error("Audio transcription is not supported on the Creative surface.");
  }
  return "generate";
}

function finalize(payload: Record<string, unknown>, jobId?: string, requestedCapability?: string): CapabilityRunResult {
  const s = structured(payload) as Record<string, unknown>;
  const outputUrl = extractReference(payload);
  if (!outputUrl) throw new Error("Livepeer completed without an output URL.");
  const cost =
    typeof s.cost_paid_usd === "number"
      ? s.cost_paid_usd
      : typeof s.cost_usd_estimated === "number"
        ? s.cost_usd_estimated
        : typeof s.cost_usd === "number"
          ? s.cost_usd
          : typeof s.total_cost_usd === "number"
            ? s.total_cost_usd
            : undefined;
  const substitution =
    s.model_note ? JSON.stringify(s.model_note)
    : s.model_substitution ? JSON.stringify(s.model_substitution)
    : s.substitution_note && typeof s.substitution_note === "string"
      ? s.substitution_note
      : undefined;
  return {
    outputUrl,
    status: extractStatus(payload) || "completed",
    raw: s,
    humanSummary: extractHumanSummary(payload),
    capability: str(s.capability ?? s.capability_used ?? s.model ?? s.model_used) ?? requestedCapability,
    requestedCapability,
    modelNote: substitution,
    jobId,
    costUsd: cost
  };
}

export function isLivepeerConfigured(): boolean {
  return true; // raw surface supports hosted access; always callable
}

function assertToolOk(payload: Record<string, unknown>, label: string): void {
  const result = payload.result as { isError?: boolean } | undefined;
  if (payload.error || result?.isError) {
    throw new Error(`${label} failed: ${resultText(payload).slice(0, 400)}`);
  }
}

function structured(payload: Record<string, unknown>): Record<string, unknown> {
  const result = payload.result as Record<string, unknown> | undefined;
  return (result?.structuredContent as Record<string, unknown>) ?? (result as Record<string, unknown>) ?? payload;
}

function resultText(payload: Record<string, unknown>): string {
  const result = payload.result as { content?: Array<{ text?: string }> } | undefined;
  if (!Array.isArray(result?.content)) return "";
  return result.content
    .map((item) => item.text)
    .filter(Boolean)
    .join("\n");
}

function extractHumanSummary(payload: Record<string, unknown>): string | undefined {
  const s = structured(payload);
  const candidate = s?.human_summary ?? s?.humanSummary;
  return typeof candidate === "string" && candidate ? candidate : undefined;
}

function extractJobId(payload: Record<string, unknown>): string | undefined {
  const s = structured(payload) as Record<string, unknown>;
  for (const candidate of [s?.job_id, s?.jobId]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  const match = resultText(payload).match(/(?:job_id|jobId)["'\s:]+([A-Za-z0-9_-]+)/);
  return match?.[1];
}

function extractStatus(payload: Record<string, unknown>): string {
  const s = structured(payload) as Record<string, unknown>;
  for (const candidate of [s?.status, s?.state]) {
    if (typeof candidate === "string") return candidate.toLowerCase();
  }
  return resultText(payload).match(/status["'\s:]+([A-Za-z_-]+)/i)?.[1]?.toLowerCase() ?? "";
}

function isFailed(status: string): boolean {
  return ["failed", "cancelled", "canceled", "error"].includes(status);
}

/** Terminal provider states: nothing further will arrive for the job. */
function isTerminal(status: string): boolean {
  return ["completed", "complete", "succeeded", "success", "failed", "cancelled", "canceled", "error", "timeout", "timed_out"].includes(status);
}

function extractReference(payload: Record<string, unknown>): string | undefined {
  return extractReferences(payload)[0];
}

/** All output-candidate URLs in trust order (structured fields, then media extensions). */
function extractReferences(payload: Record<string, unknown>): string[] {
  const s = structured(payload) as Record<string, unknown>;
  const excluded = [s?.source_url, s?.source_upstream_url].filter(
    (v): v is string => typeof v === "string" && v.startsWith("http")
  );
  const isOutput = (url: string) =>
    url.startsWith("http") && !excluded.includes(url);
  const found: string[] = [];
  // structured output fields, in trust order
  for (const candidate of [s?.url, s?.output_url, s?.video_url, s?.image_url, s?.audio_url]) {
    if (typeof candidate === "string" && isOutput(candidate) && !found.includes(candidate)) found.push(candidate);
  }
  const haystack = `${resultText(payload)}\n${JSON.stringify(payload.result ?? {})}`;
  const urls = (haystack.match(/https?:\/\/[^"'\s)\\]+/g) ?? []).map((u) => u.replace(/[.,]+$/, "")).filter(isOutput);
  for (const url of urls) {
    if (!found.includes(url)) found.push(url);
  }
  // Prefer obvious media extensions first, then fall back to discovery order.
  const media = found.filter((url) => /\.(?:mp4|webm|mov|m4v|png|jpe?g|webp|gif)(?:\?|$)/i.test(url));
  return [...media, ...found.filter((url) => !media.includes(url))];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "output";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
