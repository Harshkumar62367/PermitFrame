import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildMuxRequest,
  buildTtsRequest,
  checkNarrationFitsReel,
  estimateNarrationSeconds,
  isNarrationStale,
  NARRATION_CHARS_PER_SECOND,
  NARRATION_SCRIPT_MAX_CHARS,
  NARRATION_STALE_MS,
  narrationDisplayStatus,
  narrationMuxBudget,
  narrationRecoveryError,
  canRetryNarrationJob,
  parseMuxResult,
  parseTtsResult,
  safePhaseState,
  validateNarrationCap,
  validateNarrationScript,
  type FilmNarrationJob
} from "./narration-policy";

/**
 * Narration policy tests: script validation (plain-text, product limit,
 * no truncation), conservative duration math, reel-fit rejection, exact
 * TTS/mux request fields (contract-derived), cap math, defensive
 * parsers, and staleness derivation. No network, no spend.
 */

function job(over: Partial<FilmNarrationJob> = {}): FilmNarrationJob {
  return {
    id: "filmnar_1",
    campaignId: "cmp_x",
    filmRunId: "filmrun_1",
    script: "Hello world",
    scriptHash: "hash",
    estimatedSeconds: 1,
    narrationCapUsd: 5,
    sourceReelUrl: "https://cdn.example/film-reel.mp4",
    status: "queued",
    ttsIdempotencyKey: "tts_1",
    muxIdempotencyKey: "mux_1",
    attempt: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over
  };
}

describe("script validation", () => {
  it("accepts plain text and normalizes whitespace", () => {
    const r = validateNarrationScript("  Hello   world\nnew line  ");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.script, "Hello world new line");
    assert.equal(r.estimatedSeconds, estimateNarrationSeconds(r.script.length));
  });

  it("rejects empty, HTML/script tags, and control characters", () => {
    assert.equal(validateNarrationScript("   ").ok, false);
    assert.equal(validateNarrationScript(undefined).ok, false);
    const html = validateNarrationScript("Hello <b>world</b>");
    assert.equal(html.ok, false);
    if (!html.ok) assert.match(html.error, /plain text/);
    const script = validateNarrationScript("hello <script>alert(1)</script>");
    assert.equal(script.ok, false);
    const control = validateNarrationScript("hello\x07world");
    assert.equal(control.ok, false);
    if (!control.ok) assert.match(control.error, /control characters/);
  });

  it("enforces the 1,500-character product safeguard without truncating", () => {
    assert.equal(NARRATION_SCRIPT_MAX_CHARS, 1500);
    const ok = validateNarrationScript("x".repeat(1500));
    assert.equal(ok.ok, true);
    const over = validateNarrationScript("x".repeat(1501));
    assert.equal(over.ok, false);
    if (!over.ok) {
      assert.match(over.error, /1,500/);
      assert.match(over.error, /product safeguard/);
      assert.match(over.error, /not a provider limit/);
    }
  });
});

describe("duration estimate and reel fit", () => {
  it("uses the documented conservative rate and ceils", () => {
    assert.equal(NARRATION_CHARS_PER_SECOND, 14);
    assert.equal(estimateNarrationSeconds(14), 1);
    assert.equal(estimateNarrationSeconds(15), 2);
    assert.equal(estimateNarrationSeconds(140), 10);
  });

  it("rejects narration likely longer than the reel with the exact message", () => {
    assert.equal(checkNarrationFitsReel(30, 45), null);
    assert.equal(checkNarrationFitsReel(45, 45), null);
    assert.equal(
      checkNarrationFitsReel(46, 45),
      "This narration is likely longer than the reel. Shorten the script or create a longer Campaign Film first."
    );
  });
});

describe("exact request fields", () => {
  it("TTS sends only action/prompt/async/session/idempotency/cap - no voice", () => {
    const args = buildTtsRequest({ script: "Hello", sessionId: "s1", idempotencyKey: "k1", maxCostUsd: 5 });
    assert.deepEqual(args, {
      action: "tts",
      prompt: "Hello",
      async: true,
      session_id: "s1",
      idempotency_key: "k1",
      max_cost_usd: 5
    });
    assert.ok(!("voice" in args), "no verified voice value exists - voice is omitted");
    assert.ok(!("model_override" in args));
  });

  it("mux pads short narration with silence to preserve the reel duration", () => {
    const args = buildMuxRequest({
      reelUrl: "https://cdn.example/reel.mp4",
      audioUrl: "https://cdn.example/voice.mp3",
      sessionId: "s2",
      idempotencyKey: "k2",
      maxCostUsd: 4.5
    });
    assert.deepEqual(args, {
      action: "mux_audio",
      source_url: "https://cdn.example/reel.mp4",
      audio_url: "https://cdn.example/voice.mp3",
      audio_fill: "pad",
      async: true,
      session_id: "s2",
      idempotency_key: "k2",
      max_cost_usd: 4.5
    });
  });
});

describe("cap math", () => {
  it("requires a positive cap before confirmation", () => {
    assert.equal(validateNarrationCap("10").ok, true);
    if (validateNarrationCap("10").ok) {
      assert.equal((validateNarrationCap("10") as { ok: true; capUsd: number }).capUsd, 10);
    }
    assert.equal(validateNarrationCap("").ok, false);
    assert.equal(validateNarrationCap(0).ok, false);
    assert.equal(validateNarrationCap(-3).ok, false);
    assert.equal(validateNarrationCap(undefined).ok, false);
  });

  it("mux budget is cap minus known TTS cost; unknown cost blocks mux", () => {
    assert.deepEqual(narrationMuxBudget(5, 1.2), { ok: true, maxCostUsd: 3.8 });
    const unknown = narrationMuxBudget(5, undefined);
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.match(unknown.error, /unbounded mux/);
    const exhausted = narrationMuxBudget(5, 5);
    assert.equal(exhausted.ok, false);
    if (!exhausted.ok) assert.match(exhausted.error, /no budget remains/);
  });
});

describe("defensive parsers", () => {
  it("TTS accepts usable HTTPS audio, rejects echoes/video/sidecars/empties", () => {
    const good = parseTtsResult({ result: { status: "completed", audio_url: "https://cdn.example/voice.mp3", job_id: "mjob_1" } });
    assert.equal(good.outputUrl, "https://cdn.example/voice.mp3");
    assert.equal(good.providerJobId, "mjob_1");
    assert.equal(good.failed, false);
    // Generic output_url with an audio suffix is discovered; anything else is not.
    const discovered = parseTtsResult({ result: { status: "completed", output_url: "https://cdn.example/voice.wav" } });
    assert.equal(discovered.outputUrl, "https://cdn.example/voice.wav");
    // Extensionless signed URLs pass only through explicit audio keys.
    const signed = parseTtsResult({ result: { status: "completed", audio_url: "https://cdn.example/signed?token=abc" } });
    assert.equal(signed.outputUrl, "https://cdn.example/signed?token=abc");
    // Explicit video files are rejected even under audio keys.
    for (const video of [
      "https://cdn.example/clip.mp4",
      "https://cdn.example/clip.webm",
      "https://cdn.example/clip.mov",
      "https://cdn.example/clip.m4v"
    ]) {
      assert.equal(parseTtsResult({ result: { status: "completed", audio_url: video } }, []).outputUrl, undefined, video);
      assert.equal(parseTtsResult({ result: { status: "completed", audioUrl: video } }, []).outputUrl, undefined, video);
    }
    // Source-reel echo never qualifies, even under an explicit audio key.
    const reel = "https://cdn.example/reel.mp4";
    assert.equal(parseTtsResult({ result: { status: "completed", audio_url: reel } }, [reel]).outputUrl, undefined);
    assert.equal(parseTtsResult({ result: { status: "completed", url: reel } }, [reel]).outputUrl, undefined);
    // Video echoes in text or keys are rejected as narration audio.
    for (const video of [
      "https://cdn.example/clip.mp4",
      "https://cdn.example/clip.webm",
      "https://cdn.example/clip.mov",
      "https://cdn.example/clip.m4v"
    ]) {
      assert.equal(
        parseTtsResult({ result: { status: "completed", notes: `see ${video}` } }, []).outputUrl,
        undefined,
        video
      );
    }
    // Sidecars, playlists, transcripts, JSON, malformed and empty values rejected.
    for (const bad of [
      "https://cdn.example/cap.srt",
      "https://cdn.example/cap.vtt",
      "https://cdn.example/stream.m3u8",
      "https://cdn.example/t.json",
      "http://insecure.example/voice.mp3",
      "notaurl",
      ""
    ]) {
      assert.equal(parseTtsResult({ result: { status: "completed", audio_url: bad } }, []).outputUrl, undefined, bad);
    }
    const empty = parseTtsResult({ result: { nonsense: true } });
    assert.equal(empty.outputUrl, undefined);
    assert.equal(empty.providerJobId, undefined);
    const failed = parseTtsResult({ result: { status: "failed", audio_url: "https://cdn.example/voice.mp3" } });
    assert.equal(failed.failed, true);
    assert.equal(failed.outputUrl, undefined);
  });

  it("mux accepts usable HTTPS video, never the source or audio echo", () => {
    const reel = "https://cdn.example/reel.mp4";
    const audio = "https://cdn.example/voice.mp3";
    const good = parseMuxResult(
      { result: { status: "completed", output_url: "https://cdn.example/narrated.mp4" } },
      [reel, audio]
    );
    assert.equal(good.outputUrl, "https://cdn.example/narrated.mp4");
    const echo = parseMuxResult({ result: { status: "completed", output_url: reel } }, [reel, audio]);
    assert.equal(echo.outputUrl, undefined);
    const audioEcho = parseMuxResult({ result: { status: "completed", url: audio } }, [reel, audio]);
    assert.equal(audioEcho.outputUrl, undefined);
    const playlist = parseMuxResult({ result: { status: "completed", url: "https://cdn.example/out.m3u8" } }, [reel]);
    assert.equal(playlist.outputUrl, undefined);
    // Generic video-suffixed URLs discovered in text qualify; anything else does not.
    const discovered = parseMuxResult({ result: { status: "completed", notes: "file at https://cdn.example/out.mov done" } }, [reel]);
    assert.equal(discovered.outputUrl, "https://cdn.example/out.mov");
    const genericAudio = parseMuxResult({ result: { status: "completed", notes: "file at https://cdn.example/out.mp3 done" } }, [reel]);
    assert.equal(genericAudio.outputUrl, undefined);
  });

  it("extracts cost/capability only from valid structured numbers", () => {
    const parsed = parseMuxResult(
      { result: { status: "completed", output_url: "https://cdn.example/n.mp4", cost_paid_usd: 0.4, capability: "ffmpeg-mux" } },
      []
    );
    assert.equal(parsed.costUsd, 0.4);
    assert.equal(parsed.capability, "ffmpeg-mux");
    const bad = parseMuxResult({ result: { cost_usd: "free", capability: 42 } }, []);
    assert.equal(bad.costUsd, undefined);
    assert.equal(bad.capability, undefined);
  });

  it("provider status text is sanitized before persistence", () => {
    assert.equal(safePhaseState("processing"), "processing");
    assert.equal(safePhaseState("awaiting_confirmation"), "awaiting_confirmation");
    assert.equal(safePhaseState("oops <script>alert(1)</script> https://evil.example/x?token=abc"), "provider-reported state");
    assert.equal(safePhaseState("x".repeat(41)), "provider-reported state");
    assert.equal(safePhaseState(""), "provider-reported state");
  });
});

describe("staleness derivation", () => {
  const STALE_AT = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  const FRESH_AT = new Date(Date.now() - 60 * 1000).toISOString();

  it("threshold is 30 minutes past the phase dispatch claim", () => {
    assert.equal(NARRATION_STALE_MS, 30 * 60 * 1000);
    assert.equal(isNarrationStale(job({ status: "generating_narration", ttsDispatchedAt: STALE_AT })), true);
    assert.equal(isNarrationStale(job({ status: "waiting_for_narration", ttsDispatchedAt: STALE_AT })), true);
    assert.equal(isNarrationStale(job({ status: "muxing", muxDispatchedAt: STALE_AT })), true);
  });

  it("shows an unacknowledged submit as unknown after five minutes without resubmitting", () => {
    const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const missingTtsId = job({ status: "generating_narration", ttsDispatchedAt: sixMinutesAgo });
    assert.equal(narrationDisplayStatus(missingTtsId), "outcome_unknown");
    assert.equal(narrationRecoveryError(missingTtsId), null);
    assert.equal(missingTtsId.status, "generating_narration");
    assert.equal(isNarrationStale(job({ ...missingTtsId, ttsJobId: "tts_1" })), false);
    assert.equal(isNarrationStale(job({ status: "muxing", muxDispatchedAt: sixMinutesAgo })), true);
    assert.equal(isNarrationStale(job({ status: "muxing", muxDispatchedAt: sixMinutesAgo, muxJobId: "mux_1" })), false);
  });

  it("old TTS plus fresh mux does not make mux stale", () => {
    const freshMux = job({ status: "muxing", ttsDispatchedAt: STALE_AT, muxDispatchedAt: FRESH_AT });
    assert.equal(isNarrationStale(freshMux), false);
    assert.equal(narrationDisplayStatus(freshMux), "muxing");
    // Mux goes stale only 30 minutes after its own claim.
    assert.equal(
      isNarrationStale(job({ status: "muxing", ttsDispatchedAt: FRESH_AT, muxDispatchedAt: STALE_AT })),
      true
    );
  });

  it("TTS staleness derives from the TTS timestamp, never the mux one", () => {
    assert.equal(isNarrationStale(job({ status: "waiting_for_narration", ttsDispatchedAt: STALE_AT })), true);
    assert.equal(
      isNarrationStale(job({ status: "waiting_for_narration", ttsDispatchedAt: FRESH_AT, muxDispatchedAt: STALE_AT })),
      false
    );
  });

  it("queued and settled jobs are never stale; legacy rows fall back", () => {
    assert.equal(isNarrationStale(job({ status: "queued", dispatchStartedAt: STALE_AT })), false);
    assert.equal(isNarrationStale(job({ status: "generating_narration", ttsDispatchedAt: FRESH_AT })), false);
    assert.equal(isNarrationStale(job({ status: "ready", ttsDispatchedAt: STALE_AT })), false);
    assert.equal(isNarrationStale(job({ status: "failed", ttsDispatchedAt: STALE_AT })), false);
    assert.equal(isNarrationStale(job({ status: "outcome_unknown", ttsDispatchedAt: STALE_AT })), false);
    // Legacy rows without phase timestamps fall back to dispatchStartedAt.
    assert.equal(isNarrationStale(job({ status: "generating_narration", dispatchStartedAt: STALE_AT })), true);
    assert.equal(narrationDisplayStatus(job({ status: "muxing", muxDispatchedAt: STALE_AT })), "outcome_unknown");
    assert.equal(narrationDisplayStatus(job({ status: "muxing", muxDispatchedAt: FRESH_AT })), "muxing");
  });

  it("recovery and retry eligibility stay distinct", () => {
    const staleTts = { status: "generating_narration", ttsDispatchedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() } as const;
    assert.equal(narrationRecoveryError(job(staleTts)), null);
    assert.match(narrationRecoveryError(job({ status: "outcome_unknown" })) ?? "", /already preserved/);
    assert.match(narrationRecoveryError(job({ dispatchStartedAt: undefined })) ?? "", /delivery window/);
    assert.equal(canRetryNarrationJob(job({ status: "failed" })), null);
    assert.match(canRetryNarrationJob(job({ status: "outcome_unknown" })) ?? "", /Only failed/);
    assert.match(canRetryNarrationJob(job({ status: "failed", ttsJobId: "mjob_1" })) ?? "", /already reached the provider/);
  });
});
