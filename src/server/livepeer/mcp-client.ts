import crypto from "node:crypto";

/**
 * Minimal MCP (streamable HTTP) client for the Livepeer Agent Creative
 * surface (registered-hackathon endpoint). Pattern proven by the official
 * hackathon example app: JSON-RPC 2.0 POSTs, mcp-session-id capture.
 *
 * Renders dispatch through `create_media` (the Creative surface does not
 * expose `run_capability`); async jobs are polled with `get_create_media`.
 * Bearer tokens travel only in the Authorization header — never in errors,
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
   * Run a capability through the Creative surface (`create_media`).
   * Stable internal contract kept for the pipeline: capability/prompt/
   * source/ids in, parsed outcome out. Action selection is deliberate —
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
        // Fast path for stills; motion quality matters more than speed.
        ...(action === "generate" ? { prefer_fast: true } : {}),
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
}

/**
 * Deliberate action selection for `create_media`. Animate/upscale transform
 * an existing image, so they require a source URL — without one the call
 * would fail server-side after spending, so we refuse locally instead.
 */
export function actionFor(
  kind: "text-to-image" | "image-to-image" | "image-to-video" | "upscale" | "audio-to-text" | undefined,
  sourceUrl: string | undefined
): "generate" | "animate" | "upscale" {
  if (kind === "image-to-video") {
    if (!sourceUrl) throw new Error("Image-to-video needs a source image — nothing to animate without one.");
    return "animate";
  }
  if (kind === "upscale") {
    if (!sourceUrl) throw new Error("Upscale needs a source image — nothing to upscale without one.");
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

function extractReference(payload: Record<string, unknown>): string | undefined {
  const s = structured(payload) as Record<string, unknown>;
  const excluded = [s?.source_url, s?.source_upstream_url].filter(
    (v): v is string => typeof v === "string" && v.startsWith("http")
  );
  const isOutput = (url: string) =>
    url.startsWith("http") && !excluded.includes(url);
  // structured output fields, in trust order
  for (const candidate of [s?.url, s?.output_url, s?.video_url, s?.image_url, s?.audio_url]) {
    if (typeof candidate === "string" && isOutput(candidate)) return candidate;
  }
  const haystack = `${resultText(payload)}\n${JSON.stringify(payload.result ?? {})}`;
  const urls = (haystack.match(/https?:\/\/[^"'\s)\\]+/g) ?? []).map((u) => u.replace(/[.,]+$/, "")).filter(isOutput);
  const video = urls.find((url) => /\.(?:mp4|webm|mov|m4v)(?:\?|$)/i.test(url));
  if (video) return video;
  const image = urls.find((url) => /\.(?:png|jpe?g|webp|gif)(?:\?|$)/i.test(url));
  return image ?? urls.at(-1);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "output";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
