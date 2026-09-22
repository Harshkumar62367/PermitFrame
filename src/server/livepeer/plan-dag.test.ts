import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Campaign, ProductionJob, ProductionStagePlan, QualityProfile } from "../types";
import {
  decideStageRuns,
  isUsableOutputUrl,
  normalizeQualityProfile,
  normalizeStagePlan,
  resolveStageInput,
  seedStageOutputs,
  validatePlan
} from "./plan-dag";
import { resolvePlanRolesFromSnapshot, resolveRole, type CatalogueSnapshot } from "./catalogue";
import { createJobRecords, requestMetaFor } from "./pipeline";
import { composeStagePrompt } from "../policy/engine";
import { planDeliverables } from "@/components/studio/studio-model";

/**
 * Production DAG + quality-profile routing tests. Everything here is pure:
 * synthetic discovery snapshots, no MCP traffic, no inference, no spend.
 */

const SOURCE = "https://source.example/approved.png";
const KEYFRAME_OUT = "https://cdn.example/keyframe-916.png";

function snapshot(names: string[], reachable = true): CatalogueSnapshot {
  return {
    reachable,
    authMode: "keyless-hosted",
    totalReported: names.length,
    checkedAt: new Date().toISOString(),
    capabilities: names.map((name) => ({ name, kind: "ai", availability: "available", modelId: "", description: "" }))
  };
}

/** Every model the preference tables can name (mirrors live discovery). */
const ALL_KNOWN = [
  "flux-schnell", "gemini-image", "flux-dev", "seedream-5-lite", "qwen-image-3-t2i",
  "flux-pro", "gpt-image", "ideogram-v4", "recraft-v4",
  "nano-banana", "kontext-edit", "pixelcut-product-photo",
  "ltx-25-i2v-fast", "pixverse-i2v", "seedance-mini-i2v",
  "kling-v3-turbo-i2v", "kling-v3-turbo-pro-i2v", "seedance-i2v", "veo-i2v",
  "topaz-upscale", "ccsr-upscale", "chatterbox-tts", "inworld-tts", "grok-tts", "gemini-tts",
  "minimax-music-3", "music", "sonilo-v2m", "nemotron-asr", "whisper-word"
];

function legacyPlan(): Array<Pick<ProductionStagePlan, "id" | "kind" | "capability" | "label" | "format">> {
  return [
    { id: "keyframe", kind: "text-to-image", capability: "flux-schnell", label: "Campaign keyframe (9:16)", format: "9:16" },
    { id: "square-variation", kind: "image-to-image", capability: "flux-schnell", label: "Square feed variation (1:1)", format: "1:1" },
    { id: "header-169", kind: "image-to-image", capability: "flux-schnell", label: "Campaign header (16:9)", format: "16:9" },
    { id: "motion", kind: "image-to-video", capability: "seedance-mini-i2v", label: "Short vertical video (9:16, 5s)", format: "9:16" }
  ];
}

describe("quality profiles", () => {
  it("accepts the three product profiles, defaults everything else to balanced", () => {
    assert.equal(normalizeQualityProfile("draft"), "draft");
    assert.equal(normalizeQualityProfile("balanced"), "balanced");
    assert.equal(normalizeQualityProfile("premium"), "premium");
    assert.equal(normalizeQualityProfile(undefined), "balanced");
    assert.equal(normalizeQualityProfile("ultra"), "balanced");
    assert.equal(normalizeQualityProfile("FLUX-SCHNELL"), "balanced");
  });
});

describe("plan normalization (backward compatibility)", () => {
  it("legacy rows become explicit: independent stills, keyframe-bound motion", () => {
    const stages = normalizeStagePlan(legacyPlan(), "balanced");
    const byId = new Map(stages.map((s) => [s.id, s]));
    assert.deepEqual(byId.get("keyframe")?.dependsOnStageIds, []);
    assert.equal(byId.get("keyframe")?.inputSource, "approved-source");
    assert.equal(byId.get("keyframe")?.role, "conceptImage");
    for (const id of ["square-variation", "header-169"]) {
      assert.deepEqual(byId.get(id)?.dependsOnStageIds, []);
      assert.equal(byId.get(id)?.inputSource, "approved-source");
      // Source-guided, never "preserved": guided by the approved source.
      assert.equal(byId.get(id)?.role, "sourceGuidedImage");
      assert.equal(byId.get(id)?.qualityProfile, "balanced");
    }
    assert.deepEqual(byId.get("motion")?.dependsOnStageIds, ["keyframe"]);
    assert.equal(byId.get("motion")?.inputSource, "stage-output");
    assert.equal(byId.get("motion")?.role, "imageToVideo");
    assert.equal(byId.get("motion")?.durationSeconds, 5);
  });

  it("keeps explicit DAG fields untouched and honors the requested profile", () => {
    const stages = normalizeStagePlan(legacyPlan(), "premium");
    assert.ok(stages.every((s) => s.qualityProfile === "premium"));
    const custom = normalizeStagePlan(
      [{ id: "motion", kind: "image-to-video", capability: "veo-i2v", label: "m", format: "9:16", dependsOnStageIds: ["keyframe"], inputSource: "stage-output", qualityProfile: "draft", role: "imageToVideo", durationSeconds: 8 }],
      "premium"
    );
    assert.equal(custom[0].qualityProfile, "draft");
    assert.equal(custom[0].durationSeconds, 8);
  });
});

describe("plan validation", () => {
  it("topologically orders dependencies before dependents, keeps sibling order", () => {
    const ordered = validatePlan(normalizeStagePlan(legacyPlan()));
    const ids = ordered.map((s) => s.id);
    assert.ok(ids.indexOf("keyframe") < ids.indexOf("motion"));
    assert.deepEqual(ids.slice(0, 3), ["keyframe", "square-variation", "header-169"]);
  });

  it("rejects missing dependencies naming both stages", () => {
    const stages = normalizeStagePlan(legacyPlan());
    stages.find((s) => s.id === "motion")!.dependsOnStageIds = ["ghost-stage"];
    assert.throws(() => validatePlan(stages), /motion.*ghost-stage|ghost-stage.*motion/);
  });

  it("rejects self-dependencies and cycles naming the stage", () => {
    const self = normalizeStagePlan(legacyPlan());
    self.find((s) => s.id === "keyframe")!.dependsOnStageIds = ["keyframe"];
    assert.throws(() => validatePlan(self), /keyframe/);
    const cyclic = normalizeStagePlan(legacyPlan());
    cyclic.find((s) => s.id === "keyframe")!.dependsOnStageIds = ["motion"];
    cyclic.find((s) => s.id === "motion")!.dependsOnStageIds = ["keyframe"];
    assert.throws(() => validatePlan(cyclic), /cycle/i);
  });
});

describe("stage input resolution", () => {
  function ctx(outputs: Array<[string, string]> = []) {
    return { sourceMediaUrl: SOURCE, canonicalAnchorUrl: undefined, stageOutputs: new Map(outputs) };
  }

  it("independent formats use the approved source even when a sibling output exists", () => {
    // The core regression: the old linear chain fed the 9:16 output into the
    // 1:1 and the 1:1 into the 16:9. The DAG must not.
    const stages = validatePlan(normalizeStagePlan(legacyPlan()));
    const withKeyframe = ctx([["keyframe", KEYFRAME_OUT]]);
    for (const id of ["keyframe", "square-variation", "header-169"]) {
      const stage = stages.find((s) => s.id === id)!;
      const resolved = resolveStageInput(stage, withKeyframe);
      assert.equal(resolved.url, SOURCE, `${id} must derive from the approved source`);
      assert.equal(resolved.resolvedInputSource, "approved-source");
      assert.equal(resolved.sourceStageId, undefined);
    }
  });

  it("video depends only on its selected keyframe output", () => {
    const stages = validatePlan(normalizeStagePlan(legacyPlan()));
    const motion = stages.find((s) => s.id === "motion")!;
    const resolved = resolveStageInput(motion, ctx([["keyframe", KEYFRAME_OUT], ["square-variation", "https://cdn.example/square.png"]]));
    assert.equal(resolved.url, KEYFRAME_OUT);
    assert.equal(resolved.resolvedInputSource, "stage-output");
    assert.equal(resolved.sourceStageId, "keyframe");
  });

  it("unready inputs resolve to nothing with an honest reason, never a guess", () => {
    const stages = validatePlan(normalizeStagePlan(legacyPlan()));
    const motion = stages.find((s) => s.id === "motion")!;
    const missing = resolveStageInput(motion, ctx());
    assert.equal(missing.url, undefined);
    assert.match(missing.reason ?? "", /keyframe/);
    const anchorStage: ProductionStagePlan = {
      ...motion, id: "approved-cut", inputSource: "canonical-anchor", dependsOnStageIds: []
    };
    const noAnchor = resolveStageInput(anchorStage, ctx());
    assert.equal(noAnchor.url, undefined);
    assert.match(noAnchor.reason ?? "", /approved keyframe anchor/);
    const withAnchor = resolveStageInput(anchorStage, { sourceMediaUrl: SOURCE, canonicalAnchorUrl: KEYFRAME_OUT, stageOutputs: new Map() });
    assert.equal(withAnchor.url, KEYFRAME_OUT);
  });
});

describe("role resolution from live discovery", () => {
  const savedImage = process.env.LIVEPEER_IMAGE_CAPABILITY;
  const savedVideo = process.env.LIVEPEER_VIDEO_CAPABILITY;
  afterEach(() => {
    if (savedImage === undefined) delete process.env.LIVEPEER_IMAGE_CAPABILITY;
    else process.env.LIVEPEER_IMAGE_CAPABILITY = savedImage;
    if (savedVideo === undefined) delete process.env.LIVEPEER_VIDEO_CAPABILITY;
    else process.env.LIVEPEER_VIDEO_CAPABILITY = savedVideo;
  });

  it("draft/balanced/premium resolve differently with full availability", () => {
    const full = snapshot(ALL_KNOWN);
    const concept = (p: QualityProfile) => resolveRole("conceptImage", p, { available: new Set(ALL_KNOWN) });
    assert.equal(concept("draft").capability, "flux-schnell");
    assert.equal(concept("balanced").capability, "flux-dev");
    assert.equal(concept("premium").capability, "flux-pro");
    const motion = (p: QualityProfile) => resolveRole("imageToVideo", p, { available: new Set(ALL_KNOWN) });
    assert.equal(motion("draft").capability, "ltx-25-i2v-fast");
    assert.equal(motion("balanced").capability, "kling-v3-turbo-i2v");
    assert.equal(motion("premium").capability, "kling-v3-turbo-pro-i2v");
    assert.ok([concept("draft"), motion("premium")].every((r) => r.source === "discovered" && r.fallbackFrom === undefined));
    void full;
  });

  it("flux-schnell is never selected outside draft concept work", () => {
    const onlySchnell = new Set(["flux-schnell"]);
    for (const profile of ["balanced", "premium"] as QualityProfile[]) {
      const r = resolveRole("conceptImage", profile, { available: onlySchnell });
      assert.notEqual(r.capability, "flux-schnell", `${profile} must not use the draft preview model`);
      assert.equal(r.source, "default");
    }
    const full = new Set(ALL_KNOWN);
    for (const profile of ["draft", "balanced", "premium"] as QualityProfile[]) {
      const roles = resolvePlanRolesFromSnapshot(profile, snapshot(ALL_KNOWN), ["critique_batch", "critique_shot"]);
      for (const [name, r] of Object.entries(roles)) {
        // Draft image work uses the draft preview model by design; every
        // other profile/role combination must never touch it.
        if (profile === "draft" && (name === "conceptImage" || name === "sourceGuidedImage")) continue;
        assert.notEqual(r.capability, "flux-schnell", `${profile}/${name} must not use flux-schnell`);
      }
    }
    void full;
  });

  it("unavailable first picks fall back honestly with the substitution recorded", () => {
    const withoutDev = new Set(ALL_KNOWN.filter((n) => n !== "flux-dev"));
    const image = resolveRole("conceptImage", "balanced", { available: withoutDev });
    assert.equal(image.capability, "seedream-5-lite");
    assert.equal(image.fallbackFrom, "flux-dev → seedream-5-lite");
    const withoutKling = new Set(ALL_KNOWN.filter((n) => n !== "kling-v3-turbo-i2v"));
    const motion = resolveRole("imageToVideo", "balanced", { available: withoutKling });
    assert.equal(motion.capability, "pixverse-i2v");
    assert.equal(motion.fallbackFrom, "kling-v3-turbo-i2v → pixverse-i2v");
    const packshot = resolveRole("productPackshot", "balanced", {
      available: new Set(ALL_KNOWN.filter((n) => n !== "pixelcut-product-photo"))
    });
    assert.equal(packshot.capability, "flux-pro");
    assert.equal(packshot.fallbackFrom, "pixelcut-product-photo → flux-pro");
    const subject = resolveRole("subjectPreservingImage", "balanced", {
      available: new Set(ALL_KNOWN.filter((n) => n !== "nano-banana"))
    });
    assert.equal(subject.capability, "kontext-edit");
    assert.equal(subject.fallbackFrom, "nano-banana → kontext-edit");
  });

  it("nothing available yields verified defaults, never invented names", () => {
    const empty = resolveRole("conceptImage", "balanced", { available: new Set() });
    assert.equal(empty.capability, "flux-dev");
    assert.equal(empty.source, "default");
    const unreachable = resolvePlanRolesFromSnapshot("premium", snapshot([], false), []);
    assert.equal(unreachable.imageToVideo.capability, "kling-v3-turbo-pro-i2v");
    assert.equal(unreachable.imageToVideo.source, "default");
    assert.equal(unreachable.critic.tool, null);
  });

  it("operator env config wins for the image roles", () => {
    process.env.LIVEPEER_IMAGE_CAPABILITY = "custom-image-model";
    process.env.LIVEPEER_VIDEO_CAPABILITY = "custom-video-model";
    const available = new Set(ALL_KNOWN);
    assert.deepEqual(resolveRole("conceptImage", "premium", { available }).source, "configured");
    assert.equal(resolveRole("conceptImage", "premium", { available }).capability, "custom-image-model");
    assert.equal(resolveRole("imageToVideo", "draft", { available }).capability, "custom-video-model");
  });

  it("critic resolves against live tools, not models", () => {
    const batch = resolveRole("critic", "balanced", { available: new Set(), tools: ["critique_batch", "critique_shot"] });
    assert.equal(batch.tool, "critique_batch");
    assert.equal(batch.capability, null);
    const shotOnly = resolveRole("critic", "balanced", { available: new Set(), tools: ["critique_shot"] });
    assert.equal(shotOnly.tool, "critique_shot");
    assert.equal(shotOnly.fallbackFrom, "critique_batch → critique_shot");
  });
});

describe("job records carry provenance", () => {
  function campaign(): Campaign {
    return {
      id: "cmp_test",
      title: "Test",
      brand: "Brand",
      productName: "Product",
      request: {
        platform: "instagram",
        country: "GR",
        requestedClaims: [],
        transformation: "video",
        creativeBrief: "A sufficiently long creative brief for the DAG probe.",
        qualityProfile: "premium"
      },
      status: "draft",
      preflight: {
        decision: "allow",
        checkedAt: new Date().toISOString(),
        blockers: [],
        allowedClaims: [],
        promptConstraints: [],
        plan: normalizeStagePlan(legacyPlan(), "premium"),
        queriedRights: [],
        queriedFacts: [],
        sparqlPreview: ""
      },
      jobs: [],
      receipts: [],
      creatorId: "c1",
      sourceMediaId: "m1",
      passportId: "p1",
      productFactsId: "f1",
      comments: [],
      captions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  it("jobs inherit profile, role, and requested capability from the stage", () => {
    const jobs = createJobRecords(campaign());
    assert.equal(jobs.length, 4);
    const motion = jobs.find((j) => j.stageId === "motion")!;
    assert.equal(motion.qualityProfile, "premium");
    assert.equal(motion.role, "imageToVideo");
    assert.equal(motion.requestedCapability, motion.capability);
    assert.equal(motion.requestMeta?.inputSource, "stage-output");
    const square = jobs.find((j) => j.stageId === "square-variation")!;
    assert.equal(square.requestMeta?.inputSource, "approved-source");
    assert.equal(square.role, "sourceGuidedImage");
  });

  it("requestMeta describes the ask: aspect, duration, profile, role", () => {
    const meta = requestMetaFor({ kind: "image-to-video", format: "9:16", inputSource: "stage-output", qualityProfile: "draft", role: "imageToVideo" });
    assert.equal(meta.aspectRatio, "9:16");
    assert.equal(meta.durationSeconds, 5);
    assert.equal(meta.qualityProfile, "draft");
    assert.equal(meta.role, "imageToVideo");
  });
});

describe("existing campaigns still render", () => {
  it("legacy plans group into deliverables and validate cleanly", () => {
    const c = {
      preflight: { plan: legacyPlan() },
      receipts: [],
      jobs: []
    } as unknown as Campaign;
    assert.equal(planDeliverables(c).length, 3);
    assert.doesNotThrow(() => validatePlan(normalizeStagePlan(legacyPlan())));
  });
});

describe("output URL validation and seeding", () => {
  it("accepts only non-empty parseable HTTPS URLs", () => {
    assert.equal(isUsableOutputUrl("https://cdn.example/out.png"), true);
    assert.equal(isUsableOutputUrl("https://cdn.example/out.png?sig=x"), true);
    assert.equal(isUsableOutputUrl(undefined), false);
    assert.equal(isUsableOutputUrl(""), false);
    assert.equal(isUsableOutputUrl("not a url"), false);
    assert.equal(isUsableOutputUrl("http://cdn.example/out.png"), false);
    assert.equal(isUsableOutputUrl("ftp://cdn.example/out.png"), false);
    assert.equal(isUsableOutputUrl("https://"), false);
  });

  function job(stageId: string, status: ProductionJob["status"], url?: string): ProductionJob {
    return {
      id: `job_${stageId}_${status}`,
      campaignId: "cmp_x",
      stageId,
      kind: "text-to-image",
      capability: "flux-dev",
      prompt: "p",
      status,
      ...(url !== undefined ? { providerOutputUrl: url, outputUrl: url } : {})
    } as ProductionJob;
  }
  it("seeds durable outputs first, ignores failed/malformed/non-HTTPS", () => {
    const seeded = seedStageOutputs([
      job("keyframe", "preview_ready", "https://cdn.example/preview-k.png"),
      job("keyframe", "ready_to_share", "https://cdn.example/durable-k.png"),
      job("square-variation", "ready_to_share", "http://cdn.example/plain.png"),
      job("header-169", "storage_pending", "https://cdn.example/pending.png"),
      job("motion", "failed", "https://cdn.example/stale.mp4")
    ]);
    // Durable beats preview for the same stage; plain-HTTP never seeds.
    assert.equal(seeded.get("keyframe"), "https://cdn.example/durable-k.png");
    assert.equal(seeded.has("square-variation"), false);
    assert.equal(seeded.get("header-169"), "https://cdn.example/pending.png");
    assert.equal(seeded.has("motion"), false);
  });

  function splitJob(stageId: string, status: ProductionJob["status"], outputUrl?: string, providerOutputUrl?: string): ProductionJob {
    return {
      id: `job_${stageId}_${status}_split`,
      campaignId: "cmp_x",
      stageId,
      kind: "text-to-image",
      capability: "flux-dev",
      prompt: "p",
      status,
      ...(outputUrl !== undefined ? { outputUrl } : {}),
      ...(providerOutputUrl !== undefined ? { providerOutputUrl } : {})
    } as ProductionJob;
  }

  it("ready_to_share prefers the durable outputUrl over a temporary provider URL", () => {
    const seeded = seedStageOutputs([
      splitJob("keyframe", "ready_to_share", "https://cdn.example/durable.png", "https://provider.example/temp.png")
    ]);
    assert.equal(seeded.get("keyframe"), "https://cdn.example/durable.png");
  });

  it("ready_to_share falls back to a valid providerOutputUrl when outputUrl is invalid", () => {
    const seeded = seedStageOutputs([
      splitJob("keyframe", "ready_to_share", "http://cdn.example/plain.png", "https://provider.example/temp.png")
    ]);
    assert.equal(seeded.get("keyframe"), "https://provider.example/temp.png");
    const bothBad = seedStageOutputs([
      splitJob("keyframe", "ready_to_share", "http://cdn.example/plain.png", "not a url")
    ]);
    assert.equal(bothBad.has("keyframe"), false);
  });

  it("preview_ready prefers the providerOutputUrl over outputUrl", () => {
    const seeded = seedStageOutputs([
      splitJob("keyframe", "preview_ready", "https://cdn.example/echo.png", "https://provider.example/live.png")
    ]);
    assert.equal(seeded.get("keyframe"), "https://provider.example/live.png");
    const providerBad = seedStageOutputs([
      splitJob("keyframe", "preview_ready", "https://cdn.example/echo.png", "http://provider.example/plain.png")
    ]);
    assert.equal(providerBad.get("keyframe"), "https://cdn.example/echo.png");
  });

  it("no state can seed an invalid or non-HTTPS URL", () => {
    for (const status of ["ready_to_share", "storage_pending", "preview_ready"] as const) {
      for (const bad of [undefined, "", "not a url", "http://cdn.example/plain.png", "ftp://cdn.example/f.png"]) {
        const seeded = seedStageOutputs([splitJob("keyframe", status, bad, bad)]);
        assert.equal(seeded.has("keyframe"), false, `${status} must not seed ${JSON.stringify(bad)}`);
      }
    }
  });
});

describe("execution decisions", () => {
  const KEYFRAME_LABEL = "Campaign keyframe (9:16)";
  const MOTION_LABEL = "Short vertical video (9:16, 5s)";

  function job(stageId: string, status: ProductionJob["status"], url?: string): ProductionJob {
    return {
      id: `job_${stageId}_${status}_${Math.random().toString(36).slice(2, 8)}`,
      campaignId: "cmp_x",
      stageId,
      kind: stageId === "motion" ? "image-to-video" : "text-to-image",
      capability: "flux-dev",
      prompt: "p",
      status,
      ...(url !== undefined ? { providerOutputUrl: url, outputUrl: url } : {})
    } as ProductionJob;
  }

  function stages() {
    return validatePlan(normalizeStagePlan(legacyPlan(), "balanced"));
  }

  function queued(stageId: string): ProductionJob {
    return job(stageId, "queued");
  }

  it("motion-only fresh run fails with a prerequisite error and no input URL", () => {
    // No jobs ran at all: motion must NOT silently fall back to the source.
    const decisions = decideStageRuns(stages(), [queued("motion")], SOURCE, ["motion"]);
    assert.equal(decisions.length, 4);
    const motion = decisions.find((d) => d.stage.id === "motion")!;
    assert.equal(motion.action, "fail");
    assert.equal(motion.inputUrl, undefined);
    assert.equal(motion.reason, `Generate the ${KEYFRAME_LABEL} before creating ${MOTION_LABEL}.`);
    // Unselected stages are skipped, never failed.
    for (const d of decisions.filter((x) => x.stage.id !== "motion")) {
      assert.equal(d.action, "skip");
    }
  });

  it("preview-ready keyframe feeds a later motion-only run with that exact URL", () => {
    const decisions = decideStageRuns(
      stages(),
      [job("keyframe", "preview_ready", KEYFRAME_OUT), queued("motion")],
      SOURCE,
      ["motion"]
    );
    const motion = decisions.find((d) => d.stage.id === "motion")!;
    assert.equal(motion.action, "run");
    assert.equal(motion.inputUrl, KEYFRAME_OUT);
    assert.equal(motion.resolvedInputSource, "stage-output");
    assert.equal(motion.sourceStageId, "keyframe");
  });

  it("failed/malformed/non-HTTPS dependency outputs never dispatch", () => {
    for (const bad of [undefined, "", "not a url", "http://cdn.example/k.png"]) {
      const keyframe = bad === undefined ? job("keyframe", "failed") : job("keyframe", "preview_ready", bad);
      const decisions = decideStageRuns(stages(), [keyframe, queued("motion")], SOURCE, ["motion"]);
      const motion = decisions.find((d) => d.stage.id === "motion")!;
      assert.equal(motion.action, "fail", `bad output ${JSON.stringify(bad)} must not dispatch`);
      assert.equal(motion.inputUrl, undefined);
    }
  });

  it("a failed keyframe fails only its dependents; independent stills still run", () => {
    const decisions = decideStageRuns(
      stages(),
      [job("keyframe", "failed"), queued("square-variation"), queued("motion")],
      SOURCE,
      ["square-variation", "motion"]
    );
    const square = decisions.find((d) => d.stage.id === "square-variation")!;
    assert.equal(square.action, "run");
    assert.equal(square.inputUrl, SOURCE);
    const motion = decisions.find((d) => d.stage.id === "motion")!;
    assert.equal(motion.action, "fail");
    assert.match(motion.reason ?? "", new RegExp(KEYFRAME_LABEL.replace(/[()]/g, "\\$&")));
  });

  it("canonical-anchor stages fail without an explicit approved anchor", () => {
    const anchor: ProductionStagePlan = {
      id: "approved-cut",
      kind: "image-to-image",
      capability: "flux-dev",
      label: "Approved cut",
      format: "1:1",
      dependsOnStageIds: [],
      inputSource: "canonical-anchor",
      qualityProfile: "balanced",
      role: "sourceGuidedImage"
    };
    const plan = validatePlan([...stages(), anchor]);
    const decisions = decideStageRuns(plan, [queued("approved-cut")], SOURCE, ["approved-cut"]);
    const cut = decisions.find((d) => d.stage.id === "approved-cut")!;
    assert.equal(cut.action, "fail");
    assert.equal(cut.inputUrl, undefined);
    assert.equal(cut.reason, "This stage requires an approved keyframe anchor. Approve a keyframe first.");
    // ...but an explicitly approved anchor flows through untouched.
    const approved = decideStageRuns(plan, [queued("approved-cut")], SOURCE, ["approved-cut"], KEYFRAME_OUT);
    const cutOk = approved.find((d) => d.stage.id === "approved-cut")!;
    assert.equal(cutOk.action, "run");
    assert.equal(cutOk.inputUrl, KEYFRAME_OUT);
    assert.equal(cutOk.resolvedInputSource, "canonical-anchor");
  });
});

describe("stage prompts match dependencies", () => {
  function campaign(): Campaign {
    return {
      id: "cmp_test",
      title: "Test",
      brand: "Brand",
      productName: "Product",
      request: {
        platform: "instagram",
        country: "GR",
        requestedClaims: [],
        transformation: "video",
        creativeBrief: "A sufficiently long creative brief for the prompt probe.",
        qualityProfile: "balanced"
      },
      status: "draft",
      jobs: [],
      receipts: [],
      creatorId: "c1",
      sourceMediaId: "m1",
      passportId: "p1",
      productFactsId: "f1",
      comments: [],
      captions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  it("still prompts derive from the approved source, never the keyframe", () => {
    const c = campaign();
    const square = composeStagePrompt(c, "square-variation").toLowerCase();
    const header = composeStagePrompt(c, "header-169").toLowerCase();
    for (const [name, prompt] of [["square", square], ["header", header]] as const) {
      assert.ok(prompt.includes("approved source"), `${name} must name the approved source`);
      assert.ok(!prompt.includes("keyframe"), `${name} must not claim keyframe derivation`);
    }
    assert.ok(square.includes("1:1"));
    assert.ok(header.includes("16:9"));
  });
});
