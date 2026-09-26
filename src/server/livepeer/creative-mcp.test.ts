import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { LivepeerMcpClient, actionFor, livepeerConfig } from "./mcp-client";
import { assertCapabilityAvailable } from "./catalogue";
import { quoteStage, stageSpendingCeiling, parseLivePrices } from "./pricing";
import { estimateStagesLive } from "@/components/studio/studio-model";

/**
 * Creative MCP migration tests. All MCP traffic is mocked - no live renders,
 * no spend. Covers endpoint default, action mapping, arg mapping, sync/async
 * parsing, honest failures, and bearer redaction.
 */

type ToolHandler = (name: string, args: Record<string, unknown>) => Record<string, unknown>;

function envelope(payload: Record<string, unknown>): Record<string, unknown> {
  return { result: payload, jsonrpc: "2.0", id: "test-id" };
}

function okTool(structured: Record<string, unknown>, text = ""): Record<string, unknown> {
  return envelope({ structuredContent: structured, content: text ? [{ type: "text", text }] : [] });
}

function errTool(message: string): Record<string, unknown> {
  return envelope({
    content: [{ type: "text", text: message }],
    isError: true,
    structuredContent: { error: { code: "x", message }, code: "x", retryable: false }
  });
}

const INIT = envelope({
  protocolVersion: "2025-03-26",
  serverInfo: { name: "livepeer-agent-creative (demo credits - no key)" }
});

let seen: { method: string; tool?: string; args?: Record<string, unknown>; headers?: Record<string, string> }[];
let realFetch: typeof fetch | undefined;

function stubFetch(handler: ToolHandler): void {
  realFetch = globalThis.fetch;
  seen = [];
  globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (body.method === "initialize") {
      seen.push({ method: "initialize", headers });
      return new Response(JSON.stringify(INIT), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (body.method === "notifications/initialized") {
      seen.push({ method: "notifications/initialized" });
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (body.method === "tools/call") {
      const tool = String(body.params?.name);
      const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
      seen.push({ method: "tools/call", tool, args, headers });
      return new Response(JSON.stringify(handler(tool, args)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`unexpected MCP method ${body.method} (no live calls in tests)`);
  }) as typeof fetch;
}

function restoreFetch(): void {
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = undefined;
}

function syncImagePayload(): Record<string, unknown> {
  return okTool(
    {
      url: "https://cdn.example/out.png",
      status: "completed",
      capability: "flux-schnell",
      human_summary: "a rooftop keyframe",
      cost_paid_usd: 0.0032
    },
    "done"
  );
}

describe("creative endpoint configuration", () => {
  const saved = process.env.LIVEPEER_MCP_URL;
  beforeEach(() => {
    delete process.env.LIVEPEER_MCP_URL;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.LIVEPEER_MCP_URL;
    else process.env.LIVEPEER_MCP_URL = saved;
    restoreFetch();
  });

  it("defaults to the Creative surface and keeps the env override", () => {
    assert.equal(livepeerConfig().endpoint, "https://agent.livepeer.org/api/mcp/creative");
    process.env.LIVEPEER_MCP_URL = "https://example.invalid/pinned";
    assert.equal(livepeerConfig().endpoint, "https://example.invalid/pinned");
  });

  it("initializes against the Creative surface", async () => {
    stubFetch(() => okTool({}));
    const client = new LivepeerMcpClient(livepeerConfig());
    await client.ensureInitialized();
    assert.ok(seen.some((s) => s.method === "initialize"));
  });
});

describe("create_media action mapping", () => {
  afterEach(() => restoreFetch());

  it("text-to-image maps to action generate with model_override", async () => {
    stubFetch((tool) => {
      assert.equal(tool, "create_media");
      return syncImagePayload();
    });
    const client = new LivepeerMcpClient(livepeerConfig());
    const r = await client.runCapability({
      capability: "flux-schnell",
      kind: "text-to-image",
      prompt: "rooftop keyframe",
      qualityProfile: "draft",
      maxCostUsd: 0.25,
      sessionId: "cmp_abc",
      idempotencyKey: "pf_x"
    });
    const call = seen.find((s) => s.tool === "create_media");
    assert.equal(call?.args?.action, "generate");
    assert.equal(call?.args?.model_override, "flux-schnell");
    assert.equal(call?.args?.prompt, "rooftop keyframe");
    assert.equal(call?.args?.prefer_fast, true);
    assert.equal(call?.args?.max_cost_usd, 0.25);
    assert.equal(call?.args?.session_id, "permitframe_cmp_abc");
    assert.equal(call?.args?.idempotency_key, "pf_x");
    assert.equal(r.outputUrl, "https://cdn.example/out.png");
  });

  it("image-to-video maps to animate only with a source_url", async () => {
    const saved = process.env.LIVEPEER_PREFER_FAST;
    delete process.env.LIVEPEER_PREFER_FAST;
    try {
      stubFetch(() => syncImagePayload());
      const client = new LivepeerMcpClient(livepeerConfig());
      await client.runCapability({
        capability: "seedance-mini-i2v",
        kind: "image-to-video",
        prompt: "pan",
        sourceUrl: "https://cdn.example/key.png",
        inputs: { aspect_ratio: "9:16", duration: 5 }
      });
      const call = seen.find((s) => s.tool === "create_media");
      assert.equal(call?.args?.action, "animate");
      assert.equal(call?.args?.source_url, "https://cdn.example/key.png");
      assert.equal(call?.args?.duration, 5);
      assert.equal(call?.args?.prefer_fast, true, "hackathon policy sends fast tier for motion jobs too");
    } finally {
      if (saved === undefined) delete process.env.LIVEPEER_PREFER_FAST;
      else process.env.LIVEPEER_PREFER_FAST = saved;
    }
  });

  it("prefer_fast is sent for every generation while the hackathon policy is on", async () => {
    const saved = process.env.LIVEPEER_PREFER_FAST;
    delete process.env.LIVEPEER_PREFER_FAST;
    try {
      stubFetch(() => syncImagePayload());
      const client = new LivepeerMcpClient(livepeerConfig());
      const base = { capability: "flux-dev", kind: "text-to-image", prompt: "stills" } as const;
      for (const profile of ["draft", "balanced", "premium"] as const) {
        seen = [];
        await client.runCapability({ ...base, qualityProfile: profile });
        const call = seen.find((s) => s.tool === "create_media");
        assert.equal(call?.args?.prefer_fast, true, `${profile} uses the fast tier while the policy is on`);
      }
      seen = [];
      await client.runCapability({ ...base });
      const unset = seen.find((s) => s.tool === "create_media");
      assert.equal(unset?.args?.prefer_fast, true, "unset profile uses the fast tier while the policy is on");

      seen = [];
      await client.submitMedia({ ...base, qualityProfile: "balanced" });
      const submit = seen.find((s) => s.tool === "create_media");
      assert.equal(submit?.args?.prefer_fast, true, "async submits use the fast tier while the policy is on");
    } finally {
      if (saved === undefined) delete process.env.LIVEPEER_PREFER_FAST;
      else process.env.LIVEPEER_PREFER_FAST = saved;
    }
  });

  it("LIVEPEER_PREFER_FAST=false restores draft-only fast-pathing", async () => {
    const saved = process.env.LIVEPEER_PREFER_FAST;
    process.env.LIVEPEER_PREFER_FAST = "false";
    try {
      stubFetch(() => syncImagePayload());
      const client = new LivepeerMcpClient(livepeerConfig());
      const base = { capability: "flux-dev", kind: "text-to-image", prompt: "stills" } as const;
      for (const profile of ["draft", "balanced", "premium"] as const) {
        seen = [];
        await client.runCapability({ ...base, qualityProfile: profile });
        const call = seen.find((s) => s.tool === "create_media");
        if (profile === "draft") {
          assert.equal(call?.args?.prefer_fast, true);
        } else {
          assert.ok(!("prefer_fast" in (call?.args ?? {})), `${profile} must omit prefer_fast entirely`);
        }
      }
      seen = [];
      await client.runCapability({ ...base });
      const unset = seen.find((s) => s.tool === "create_media");
      assert.ok(!("prefer_fast" in (unset?.args ?? {})));

      seen = [];
      await client.runCapability({
        capability: "seedance-mini-i2v",
        kind: "image-to-video",
        prompt: "pan",
        sourceUrl: "https://cdn.example/key.png",
        inputs: { aspect_ratio: "9:16", duration: 5 }
      });
      const motion = seen.find((s) => s.tool === "create_media");
      assert.ok(!("prefer_fast" in (motion?.args ?? {})), "motion omits prefer_fast with the policy off");

      // Explicit caller opt-in still works with the policy off.
      seen = [];
      await client.submitMedia({ ...base, qualityProfile: "balanced", preferFast: true });
      const recovery = seen.find((s) => s.tool === "create_media");
      assert.equal(recovery?.args?.prefer_fast, true, "a provider-terminal retry can request the fast tier");
    } finally {
      if (saved === undefined) delete process.env.LIVEPEER_PREFER_FAST;
      else process.env.LIVEPEER_PREFER_FAST = saved;
    }
  });

  it("image-to-video without a source refuses before any spend", async () => {
    stubFetch(() => syncImagePayload());
    const client = new LivepeerMcpClient(livepeerConfig());
    await assert.rejects(
      () => client.runCapability({ capability: "seedance-mini-i2v", kind: "image-to-video", prompt: "pan" }),
      /source image/
    );
    assert.ok(!seen.some((s) => s.tool === "create_media"), "must not dispatch without a source");
  });

  it("refuses an unsupported aspect locally for every model before it reaches Creative MCP", async () => {
    stubFetch(() => syncImagePayload());
    const client = new LivepeerMcpClient(livepeerConfig());
    await assert.rejects(
      () => client.submitMedia({ capability: "gpt-image", kind: "image-to-image", prompt: "portrait", inputs: { aspect_ratio: "2:1" } }),
      /Aspect ratio "2:1" is not accepted/
    );
    assert.ok(!seen.some((s) => s.tool === "create_media"), "unsupported format must not dispatch");
  });

  it("text-to-video model dispatches as generate, never blind animate", async () => {
    stubFetch(() => syncImagePayload());
    const client = new LivepeerMcpClient(livepeerConfig());
    await client.runCapability({ capability: "seedance-mini-t2v", kind: "image-to-image", prompt: "clip" });
    assert.equal(seen.find((s) => s.tool === "create_media")?.args?.action, "generate");
  });

  it("actionFor is deliberate per kind", () => {
    assert.equal(actionFor("text-to-image", undefined), "generate");
    assert.equal(actionFor("image-to-image", "https://x/y.png"), "generate");
    assert.equal(actionFor("image-to-video", "https://x/y.png"), "animate");
    assert.equal(actionFor("upscale", "https://x/y.png"), "upscale");
    assert.throws(() => actionFor("image-to-video", undefined), /source image/);
    assert.throws(() => actionFor("upscale", undefined), /source image/);
    assert.throws(() => actionFor("audio-to-text", undefined), /not supported/);
  });
});

describe("creative result parsing", () => {
  afterEach(() => restoreFetch());

  it("parses sync results without fabrication", async () => {
    stubFetch(() =>
      okTool({
        image_url: "https://cdn.example/sync.png",
        job_id: "job_1",
        state: "succeeded",
        model: "flux-schnell",
        human_summary: "keyframe",
        model_note: { substituted: false },
        cost_usd: 0.004
      })
    );
    const r = await new LivepeerMcpClient(livepeerConfig()).runCapability({
      capability: "flux-schnell",
      kind: "text-to-image",
      prompt: "x"
    });
    assert.equal(r.outputUrl, "https://cdn.example/sync.png");
    assert.equal(r.jobId, "job_1");
    assert.equal(r.capability, "flux-schnell");
    assert.equal(r.requestedCapability, "flux-schnell");
    assert.equal(r.humanSummary, "keyframe");
    assert.equal(r.costUsd, 0.004);
    assert.ok((r.modelNote ?? "").includes("substituted"));
  });

  it("polls get_create_media for async jobs", async () => {
    let calls = 0;
    stubFetch((tool, args) => {
      calls += 1;
      if (tool === "create_media") {
        return okTool({ job_id: "job_9", status: "queued" });
      }
      assert.equal(tool, "get_create_media");
      assert.equal(args.job_id, "job_9");
      return okTool({ url: "https://cdn.example/async.mp4", status: "completed", cost_paid_usd: 0.8 });
    });
    const r = await new LivepeerMcpClient(livepeerConfig()).runCapability({
      capability: "seedance-mini-i2v",
      kind: "image-to-video",
      prompt: "pan",
      sourceUrl: "https://cdn.example/key.png",
      timeoutSeconds: 60
    });
    assert.equal(r.outputUrl, "https://cdn.example/async.mp4");
    assert.equal(r.jobId, "job_9");
    assert.equal(r.costUsd, 0.8);
    assert.ok(calls >= 2);
  });

  it("missing output with no job id throws instead of guessing", async () => {
    stubFetch(() => okTool({ status: "completed" }));
    await assert.rejects(
      () => new LivepeerMcpClient(livepeerConfig()).runCapability({ capability: "flux-schnell", kind: "text-to-image" }),
      /no output and no job id/
    );
  });
});

describe("honest creative failures", () => {
  afterEach(() => restoreFetch());

  it("quota exhaustion surfaces verbatim", async () => {
    stubFetch((tool) => {
      if (tool === "create_media") return errTool("credit exhausted: 0 remaining on this hacker balance");
      return okTool({});
    });
    await assert.rejects(
      () => new LivepeerMcpClient(livepeerConfig()).runCapability({ capability: "flux-schnell", kind: "text-to-image" }),
      /credit exhausted/
    );
  });

  it("max-cost rejection surfaces verbatim", async () => {
    stubFetch((tool) => {
      if (tool === "create_media") return errTool("quote $1.20 exceeds max_cost_usd $0.25 - raise the ceiling or pick a cheaper model");
      return okTool({});
    });
    await assert.rejects(
      () =>
        new LivepeerMcpClient(livepeerConfig()).runCapability({ capability: "flux-pro", kind: "text-to-image", maxCostUsd: 0.25 }),
      /max_cost_usd/
    );
  });

  it("unavailable capability is refused before dispatch", async () => {
    stubFetch((tool) => {
      if (tool === "list_capabilities") {
        return envelope({
          structuredContent: {
            total: 1,
            returned: 1,
            offset: 0,
            capabilities: [{ name: "flux-schnell", kind: "ai", availability: "available", model_id: "", description: "" }]
          },
          content: []
        });
      }
      return okTool({});
    });
    await assertCapabilityAvailable("flux-schnell");
    await assert.rejects(() => assertCapabilityAvailable("nope-not-real"), /not currently available/);
  });

  it("bearer values never appear in thrown errors", async () => {
    const saved = process.env.LIVEPEER_MCP_BEARER;
    process.env.LIVEPEER_MCP_BEARER = "secret-bearer-xyz-123";
    try {
      stubFetch((tool) => {
        if (tool === "create_media") return errTool("unauthorized: bad credentials");
        return okTool({});
      });
      const calls = seen;
      const err = await new LivepeerMcpClient(livepeerConfig())
        .runCapability({ capability: "flux-schnell", kind: "text-to-image" })
        .then(() => assert.fail("must throw"), (e: Error) => e);
      assert.ok(!err.message.includes("secret-bearer-xyz-123"), "error must not carry the bearer");
      assert.ok(
        calls.some((c) => (c.headers?.authorization ?? "").startsWith("Bearer ")),
        "bearer still travels in the Authorization header"
      );
    } finally {
      if (saved === undefined) delete process.env.LIVEPEER_MCP_BEARER;
      else process.env.LIVEPEER_MCP_BEARER = saved;
    }
  });
});

describe("live pricing quotes", () => {
  it("parses both envelope shapes from get_pricing", () => {
    const row = { name: "flux-schnell", display_price_usd: 0.003, display_unit: "image", unit_kind: "image" };
    const unwrapped = parseLivePrices({ capabilities: [row] });
    const enveloped = parseLivePrices({ structuredContent: { capabilities: [row] } });
    assert.equal(unwrapped.get("flux-schnell")?.usd, 0.003);
    assert.equal(enveloped.get("flux-schnell")?.usd, 0.003);
    assert.equal(parseLivePrices({}).size, 0);
  });

  it("maps per-image and per-second live prices exactly", () => {
    const live = new Map([
      ["flux-schnell", { usd: 0.003, unit: "image", unitKind: "image" }],
      ["pixverse-t2v", { usd: 0.0683, unit: "second", unitKind: "time" }]
    ]);
    assert.deepEqual(quoteStage({ capability: "flux-schnell", kind: "text-to-image" }, live), { usd: 0.003, exact: true });
    assert.deepEqual(quoteStage({ capability: "pixverse-t2v", kind: "image-to-video" }, live), { usd: 0.3415, exact: true });
  });

  it("per-megapixel and unknown units fall back inexact, never invented", () => {
    const live = new Map([["flux-dev", { usd: 0.0262, unit: "megapixel", unitKind: "area" }]]);
    const q = quoteStage({ capability: "flux-dev", kind: "text-to-image" }, live);
    assert.ok(q && !q.exact, "megapixel units are estimates, not quotes");
    assert.equal(quoteStage({ capability: "nope", kind: "text-to-image" }, live), null);
  });

  it("spending ceilings bound runaway renders", () => {
    const live = new Map([["flux-schnell", { usd: 0.003, unit: "image", unitKind: "image" }]]);
    assert.equal(stageSpendingCeiling({ capability: "flux-schnell", kind: "text-to-image" }, live), 0.25);
    assert.equal(stageSpendingCeiling({ capability: "nope", kind: "text-to-image" }, live), 5);
  });

  it("studio live totals are exact only when fully mappable", () => {
    const live = {
      "flux-schnell": { usd: 0.003, unit: "image" },
      "pixverse-t2v": { usd: 0.0683, unit: "second" }
    };
    const stages = [
      { id: "a", kind: "text-to-image", capability: "flux-schnell", label: "A", format: "9:16" },
      { id: "b", kind: "image-to-video", capability: "pixverse-t2v", label: "B", format: "9:16" }
    ] as Parameters<typeof estimateStagesLive>[0];
    assert.deepEqual(estimateStagesLive(stages, live), { total: 0.003 + 0.0683 * 5, exact: true });
    assert.equal(estimateStagesLive(stages, null), null);
    const partial = estimateStagesLive(stages, { "flux-schnell": { usd: 0.003, unit: "image" } });
    assert.ok(partial && !partial.exact, "unmapped stages make the total inexact");
  });
});

describe("film cancellation note safety", () => {
  afterEach(() => restoreFetch());

  /**
   * cancel_creative_job notes are stable user-safe strings: SSH paths,
   * URLs, tokens, payload fragments, and stack-like text from hostile
   * provider responses (or transport failures) never reach the returned
   * note - and therefore never reach the persisted run record. Raw causes
   * go only to the redacted server log.
   */
  const HOSTILE_BITS = [
    "/home/deployer/.ssh/id_ed25519_dkg_ec2",
    "https://hooks.example/dispatch?token=tok_abc123",
    "Bearer eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature",
    "sk-live-provider-key-999",
    "-----BEGIN PRIVATE KEY-----",
    "at cancelCreativeJob (node:internal/process:99:5)"
  ];

  function assertNoteClean(note: string, expected: string): void {
    assert.equal(note, expected);
    for (const bit of HOSTILE_BITS) {
      assert.ok(!note.includes(bit), `cancel note must not contain ${JSON.stringify(bit.slice(0, 40))}`);
    }
  }

  it("confirmed cancellation returns the stable note despite hostile payload text", async () => {
    stubFetch((tool) => {
      assert.equal(tool, "cancel_creative_job");
      return okTool(
        { status: "cancelled", job_id: "cjob_abc123" },
        `cancelled ${HOSTILE_BITS.join(" ")}`
      );
    });
    const result = await new LivepeerMcpClient(livepeerConfig()).cancelCreativeJob("cjob_abc123");
    assert.equal(result.cancelled, true);
    assertNoteClean(result.note, "Provider confirmed cancellation.");
  });

  it("unconfirmed cancellation hides payload fragments behind the stable note", async () => {
    stubFetch((tool) => {
      assert.equal(tool, "cancel_creative_job");
      return okTool(
        { status: "running", job_id: "cjob_abc123" },
        `still running: ssh -i ${HOSTILE_BITS[0]} dispatch ${HOSTILE_BITS[1]}`
      );
    });
    const result = await new LivepeerMcpClient(livepeerConfig()).cancelCreativeJob("cjob_abc123");
    assert.equal(result.cancelled, false);
    assertNoteClean(result.note, "Provider did not confirm cancellation.");
  });

  it("transport failure hides secrets behind the stable note", async () => {
    stubFetch(() => {
      throw new Error(`fetch failed for https://hooks.example/x?token=tok_abc123 with Bearer ${HOSTILE_BITS[2].slice(7, 27)}`);
    });
    const result = await new LivepeerMcpClient(livepeerConfig()).cancelCreativeJob("cjob_abc123");
    assert.equal(result.cancelled, false);
    assertNoteClean(result.note, "Provider cancel request failed before confirmation.");
  });

  it("older cancel_job path uses the same stable notes", async () => {  stubFetch((tool) => {
      assert.equal(tool, "cancel_job");
      return okTool(
        { status: "running", job_id: "mjob_42" },
        `still running: ssh -i ${HOSTILE_BITS[0]} dispatch ${HOSTILE_BITS[1]} ${HOSTILE_BITS[5]}`
      );
    });
    const refused = await new LivepeerMcpClient(livepeerConfig()).cancelProviderJob("mjob_42");
    assert.equal(refused.cancelled, false);
    assertNoteClean(refused.note, "Provider did not confirm cancellation.");

    stubFetch((tool) => {
      assert.equal(tool, "cancel_job");
      return okTool({ status: "cancelled", job_id: "mjob_42" }, `cancelled ${HOSTILE_BITS[3]} ${HOSTILE_BITS[4]}`);
    });
    const confirmed = await new LivepeerMcpClient(livepeerConfig()).cancelProviderJob("mjob_42");
    assert.equal(confirmed.cancelled, true);
    assertNoteClean(confirmed.note, "Provider confirmed cancellation.");

    stubFetch(() => {
      throw new Error(`socket hang up reaching ${HOSTILE_BITS[1]} with ${HOSTILE_BITS[2].slice(0, 20)}`);
    });
    const failed = await new LivepeerMcpClient(livepeerConfig()).cancelProviderJob("mjob_42");
    assert.equal(failed.cancelled, false);
    assertNoteClean(failed.note, "Provider cancel request failed before confirmation.");
  });
});

describe("critique note safety", () => {
  afterEach(() => restoreFetch());

  /**
   * critique_shot notes are fixed product-owned messages derived from safe
   * values only (score, threshold, parseability). Hostile provider text in
   * pass_fail / verdict / free-text content - SSH paths, bearer/JWT text,
   * signed URLs, stack traces, provider error strings - never reaches the
   * returned note, and therefore never reaches qualityNote, Review, Queue,
   * the plan, API responses, or stored job metadata. Pass semantics stay
   * exactly as before.
   */
  const HOSTILE_BITS = [
    "/home/deployer/.ssh/id_ed25519_dkg_ec2",
    "https://vision.example/signed/critique?token=tok_abc123&expires=99",
    "Bearer eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature",
    "at critiqueShot (node:internal/vision:99:5)",
    "PROVIDER_ERROR: vision backend quota exhausted (code 429)"
  ];

  const CRITIQUE_INPUT = {
    generatedUrl: "https://cdn.example/k.png",
    referenceUrl: "https://s.example/p.png"
  };

  function assertNoteClean(note: string, expected: string): void {
    assert.equal(note, expected);
    for (const bit of HOSTILE_BITS) {
      assert.ok(!note.includes(bit), `critique note must not contain ${JSON.stringify(bit.slice(0, 40))}`);
    }
  }

  it("failed score uses the fixed message despite hostile verdict text", async () => {
    stubFetch((tool) => {
      assert.equal(tool, "critique_shot");
      return okTool(
        {
          weighted_total: 0.42,
          pass_fail: `FAIL ssh -i ${HOSTILE_BITS[0]} ${HOSTILE_BITS[4]}`,
          verdict: `fail ${HOSTILE_BITS[1]} ${HOSTILE_BITS[2]}`
        },
        `verdict text ${HOSTILE_BITS[3]} ${HOSTILE_BITS[4]}`
      );
    });
    const critique = await new LivepeerMcpClient(livepeerConfig()).critiqueShot(CRITIQUE_INPUT);
    assert.equal(critique.score, 0.42);
    assert.equal(critique.passed, false);
    assertNoteClean(critique.note, "Automated visual check scored 0.42 below the 0.70 review threshold.");
  });

  it("passed score uses the fixed message and keeps pass semantics", async () => {
    stubFetch((tool) => {
      assert.equal(tool, "critique_shot");
      return okTool({ weighted_total: 0.86, pass_fail: "pass" });
    });
    const critique = await new LivepeerMcpClient(livepeerConfig()).critiqueShot(CRITIQUE_INPUT);
    assert.equal(critique.score, 0.86);
    assert.equal(critique.passed, true);
    assertNoteClean(critique.note, "Automated visual check scored 0.86 against the 0.70 review threshold.");
  });

  it("missing score uses the fixed no-score message and keeps advisory-pass semantics", async () => {
    stubFetch((tool) => {
      assert.equal(tool, "critique_shot");
      return okTool(
        { pass_fail: `error ${HOSTILE_BITS[4]} ${HOSTILE_BITS[0]}` },
        `no score ${HOSTILE_BITS[1]} ${HOSTILE_BITS[2]} ${HOSTILE_BITS[3]}`
      );
    });
    const critique = await new LivepeerMcpClient(livepeerConfig()).critiqueShot(CRITIQUE_INPUT);
    assert.equal(critique.score, null);
    assert.equal(critique.passed, true);
    assertNoteClean(critique.note, "Automated visual check did not return a usable score.");
  });

  it("custom threshold is reflected in the fixed message", async () => {
    stubFetch((tool) => {
      assert.equal(tool, "critique_shot");
      return okTool({ total: 0.75, verdict: `borderline ${HOSTILE_BITS[1]}` });
    });
    const critique = await new LivepeerMcpClient(livepeerConfig()).critiqueShot({ ...CRITIQUE_INPUT, threshold: 0.8 });
    assert.equal(critique.score, 0.75);
    assert.equal(critique.passed, false);
    assertNoteClean(critique.note, "Automated visual check scored 0.75 below the 0.80 review threshold.");
  });
});

describe("transcribe call shape", () => {
  afterEach(() => restoreFetch());

  it("sends only source_url, burn:true, and language", async () => {
    stubFetch((tool, args) => {
      assert.equal(tool, "transcribe");
      assert.deepEqual(args, {
        source_url: "https://cdn.example/film-reel.mp4",
        burn: true,
        language: "en"
      });
      return okTool(
        { captioned_url: "https://cdn.example/film-reel-captions.mp4", transcript: "hello", status: "completed" },
        "done"
      );
    });
    const parsed = await new LivepeerMcpClient(livepeerConfig()).transcribeForCaptions({
      sourceUrl: "https://cdn.example/film-reel.mp4",
      language: "en"
    });
    assert.equal(parsed.outputUrl, "https://cdn.example/film-reel-captions.mp4");
    assert.equal(parsed.transcriptText, "hello");
  });

  it("provider rejections throw for honest failure handling", async () => {
    stubFetch((tool) => {
      assert.equal(tool, "transcribe");
      return errTool("transcribe refused: unsupported source host");
    });
    await assert.rejects(
      () =>
        new LivepeerMcpClient(livepeerConfig()).transcribeForCaptions({
          sourceUrl: "https://cdn.example/film-reel.mp4",
          language: "en"
        }),
      /unsupported source host/
    );
  });
});

describe("narration call shape", () => {
  afterEach(() => restoreFetch());

  it("sends exactly the contract TTS fields - no voice, no extras", async () => {
    stubFetch((tool, args) => {
      assert.equal(tool, "create_media");
      assert.deepEqual(args, {
        action: "tts",
        prompt: "Say this",
        async: true,
        session_id: "s1",
        idempotency_key: "k1",
        max_cost_usd: 5
      });
      return okTool({ job_id: "mjob_tts1", status: "processing" });
    });
    const parsed = await new LivepeerMcpClient(livepeerConfig()).submitNarrationTts({
      prompt: "Say this",
      sessionId: "s1",
      idempotencyKey: "k1",
      maxCostUsd: 5,
      excludeUrls: ["https://cdn.example/reel.mp4"]
    });
    assert.equal(parsed.providerJobId, "mjob_tts1");
  });

  it("sends exactly the contract mux fields with audio_fill pad", async () => {
    stubFetch((tool, args) => {
      assert.equal(tool, "create_media");
      assert.deepEqual(args, {
        action: "mux_audio",
        source_url: "https://cdn.example/reel.mp4",
        audio_url: "https://cdn.example/voice.mp3",
        audio_fill: "pad",
        async: true,
        session_id: "s2",
        idempotency_key: "k2",
        max_cost_usd: 3.9
      });
      return okTool({ job_id: "mjob_mux1", status: "processing" });
    });
    const parsed = await new LivepeerMcpClient(livepeerConfig()).submitMuxAudio({
      sourceUrl: "https://cdn.example/reel.mp4",
      audioUrl: "https://cdn.example/voice.mp3",
      sessionId: "s2",
      idempotencyKey: "k2",
      maxCostUsd: 3.9
    });
    assert.equal(parsed.providerJobId, "mjob_mux1");
  });
});
