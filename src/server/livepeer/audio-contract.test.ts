import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUDIO_CONTRACTS,
  REJECTED_AUDIO_ASSUMPTIONS,
  assertAudioDispatchable,
  audioContractFor,
  type AudioOperation
} from "./audio-contract";

/**
 * Audio contract audit tests: the gate admits exactly the four verified
 * create_media audio actions with their observed required fields, and
 * refuses everything else - unknown names, field-name traps, and the
 * partially verified soundtrack export. No dispatch exists in this
 * module, so "cannot be dispatched" means the gate throws before any
 * provider call could be built.
 */

describe("verified audio operations pass the gate", () => {
  const cases: { op: AudioOperation; tool: string; action: string; required: string[] }[] = [
    { op: "tts_narration", tool: "create_media", action: "tts", required: ["action", "prompt"] },
    { op: "music_bed", tool: "create_media", action: "music", required: ["action", "prompt", "duration"] },
    { op: "mix_tracks", tool: "create_media", action: "mix_tracks", required: ["action", "tracks"] },
    { op: "mux_audio", tool: "create_media", action: "mux_audio", required: ["action", "source_url", "audio_url"] }
  ];
  for (const { op, tool, action, required } of cases) {
    it(`${op} resolves verified with exact required fields`, () => {
      const contract = assertAudioDispatchable(op);
      assert.equal(contract.confidence, "verified");
      assert.equal(contract.tool, tool);
      assert.equal(contract.action, action);
      for (const field of required) {
        assert.ok(contract.requiredFields.includes(field), `${op} must require ${field}`);
      }
      assert.ok(contract.async?.statusTool === "get_create_media", `${op} polls get_create_media`);
      assert.ok((contract.async?.idempotencyKey ?? false), `${op} supports idempotency keys`);
      assert.ok(contract.prices.length > 0, `${op} has observed pricing`);
      assert.ok(contract.capabilities.length > 0, `${op} has observed capabilities`);
    });
  }

  it("cost controls are verified on every dispatchable operation", () => {
    for (const op of ["tts_narration", "music_bed", "mix_tracks", "mux_audio"] as AudioOperation[]) {
      const contract = assertAudioDispatchable(op);
      assert.ok(contract.optionalFields.includes("max_cost_usd"), `${op} supports pre-flight caps`);
      assert.ok(contract.async?.preflightCapField === "max_cost_usd");
      assert.equal(contract.async?.costLedger, "get_cost_report");
    }
  });
});

describe("unknown operations cannot be dispatched", () => {
  it("unknown names throw before any call is built", () => {
    for (const name of [
      "soundtrack_auto",
      "voice_clone_via_audio_url",
      "mix",
      "lipsync_to_reel",
      "tts",
      "music",
      "",
      "TTS_NARRATION"
    ]) {
      assert.throws(() => assertAudioDispatchable(name), /no verified provider contract|not dispatchable/);
      assert.throws(() => audioContractFor(name), /no verified provider contract/);
    }
  });

  it("field-name traps are recorded and refused", () => {
    assert.ok(REJECTED_AUDIO_ASSUMPTIONS.length >= 5);
    for (const trap of REJECTED_AUDIO_ASSUMPTIONS) {
      assert.ok(trap.reason.length > 0);
      assert.throws(() => assertAudioDispatchable(trap.name), /no verified provider contract/);
    }
  });

  it("partially verified soundtrack_export is not dispatchable", () => {
    const contract = audioContractFor("soundtrack_export");
    assert.equal(contract.confidence, "partially_verified");
    assert.throws(() => assertAudioDispatchable("soundtrack_export"), /partially_verified/);
  });

  it("the registry holds exactly the five audited operations", () => {
    assert.deepEqual(Object.keys(AUDIO_CONTRACTS).sort(), [
      "mix_tracks",
      "music_bed",
      "mux_audio",
      "soundtrack_export",
      "tts_narration"
    ]);
  });
});
