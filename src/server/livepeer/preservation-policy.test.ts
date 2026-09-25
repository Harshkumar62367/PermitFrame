import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Campaign, ProductionJob, ProductionStagePlan, StageRole } from "../types";
import {
  FIDELITY_REFUSAL,
  firstUsableOutput,
  classifyPreservationResult,
  isPreservationSourceUsable,
  isProductPhotoSupported,
  isStrictFidelity,
  preservationOperationKey,
  requestedPreservationMode,
  resolvePreservation,
  type PreservationContext
} from "./preservation-policy";
import { fidelityPillFor, normalizePreservation, preservationIndicator, REFERENCE_GUIDED_COPY } from "@/lib/preservation";
import { provenanceMeta, preservationContextFor } from "./runner";
import { requestMetaFor } from "./pipeline";

/**
 * Prompt 4 tests: approved-reference / subject / product preservation.
 * Pure policy + provenance persistence - no Livepeer traffic, no spend.
 */

const SOURCE = "https://source.example/approved.png";
const OUTPUT = "https://cdn.example/keyframe.png";

function ctx(partial: Partial<PreservationContext> = {}): PreservationContext {
  return {
    stageId: "keyframe",
    kind: "image-to-image",
    role: "sourceGuidedImage",
    sourceUrl: SOURCE,
    sourceAssetId: "src_1",
    sourceOwnedByCampaign: true,
    rightsAllowed: true,
    variationExplicit: false,
    placeSubjectMode: "auto",
    ...partial
  };
}

function stage(partial: Partial<ProductionStagePlan> = {}): ProductionStagePlan {
  return {
    id: "keyframe",
    kind: "image-to-image",
    capability: "flux-dev",
    label: "Keyframe",
    format: "9:16",
    dependsOnStageIds: [],
    inputSource: "approved-source",
    qualityProfile: "balanced",
    role: "sourceGuidedImage",
    ...partial
  };
}

describe("source URL validation", () => {
  it("accepts absolute HTTPS URLs with a host", () => {
    assert.equal(isPreservationSourceUsable(SOURCE), true);
  });
  it("rejects blanks, relatives, data URLs, and non-https", () => {
    for (const bad of ["", "  ", "/local.png", "http://cdn.example/a.png", "data:image/png;base64,xx", "https://", "https://nodot", null, undefined, 42]) {
      assert.equal(isPreservationSourceUsable(bad), false, JSON.stringify(bad));
    }
  });
});

describe("requested mode derivation (never from model names)", () => {
  it("derives subject-placement from the subjectPreservingImage role", () => {
    assert.equal(requestedPreservationMode({ role: "subjectPreservingImage", variationExplicit: false, variationSourceUrl: undefined }), "subject-placement");
  });
  it("derives product-photo from the productPackshot role", () => {
    assert.equal(requestedPreservationMode({ role: "productPackshot", variationExplicit: false, variationSourceUrl: undefined }), "product-photo");
  });
  it("requests variation only when explicit AND a usable source is selected", () => {
    assert.equal(
      requestedPreservationMode({ role: "sourceGuidedImage", variationExplicit: true, variationSourceUrl: OUTPUT }),
      "variation"
    );
    // A usable URL alone is never a variation request.
    assert.equal(
      requestedPreservationMode({ role: "sourceGuidedImage", variationExplicit: false, variationSourceUrl: OUTPUT }),
      "source-guided-generation"
    );
    assert.equal(
      requestedPreservationMode({ role: "sourceGuidedImage", variationExplicit: true, variationSourceUrl: undefined }),
      "source-guided-generation"
    );
    assert.equal(
      requestedPreservationMode({ role: "sourceGuidedImage", variationExplicit: true, variationSourceUrl: "not-a-url" }),
      "source-guided-generation"
    );
  });
  it("defaults everything else to source-guided generation", () => {
    for (const role of ["conceptImage", "sourceGuidedImage", "imageToVideo", "upscale", "tts", "music", "subtitle", "critic"] as StageRole[]) {
      assert.equal(
        requestedPreservationMode({ role, variationExplicit: false, variationSourceUrl: undefined }),
        "source-guided-generation",
        role
      );
    }
  });
});

describe("subject-placement eligibility", () => {
  it("resolves subject-placement for an eligible image stage", () => {
    const d = resolvePreservation(ctx({ role: "subjectPreservingImage" }));
    assert.equal(d.requested, "subject-placement");
    assert.equal(d.resolved, "subject-placement");
    assert.equal(d.requestedCapability, "place_subject");
    assert.equal(d.actualCapability, "place_subject");
    assert.equal(d.evidenceLevel, "subject-preserving");
    assert.equal(d.refusal, undefined);
    assert.equal(d.allowFallbackToSourceGuided, true);
    assert.equal(d.approvedSourceAssetId, "src_1");
    assert.ok(d.approvedSourceUrlFingerprint && d.approvedSourceUrlFingerprint.length === 64);
    assert.deepEqual(d.sourceValidation, { sourceUrlUsable: true, rightsAllowed: true, sourceOwned: true });
  });
  it("refuses before dispatch when the source is missing", () => {
    const d = resolvePreservation(ctx({ role: "subjectPreservingImage", sourceUrl: undefined, sourceAssetId: undefined }));
    assert.ok(d.refusal, "expected a refusal");
    assert.equal(d.resolved, "source-guided-generation");
  });
  it("refuses before dispatch when the source is not a usable HTTPS URL", () => {
    const d = resolvePreservation(ctx({ role: "subjectPreservingImage", sourceUrl: "http://cdn.example/a.png" }));
    assert.ok(d.refusal);
  });
  it("refuses before dispatch when rights are not allowed", () => {
    const d = resolvePreservation(ctx({ role: "subjectPreservingImage", rightsAllowed: false }));
    assert.ok(d.refusal);
    assert.match(d.refusal, /Rights are not currently allowed/);
  });
  it("refuses before dispatch when source ownership is unverified", () => {
    const d = resolvePreservation(ctx({ role: "subjectPreservingImage", sourceOwnedByCampaign: false }));
    assert.ok(d.refusal);
    assert.match(d.refusal, /ownership/);
  });
  it("never permits subject placement for video stages", () => {
    const d = resolvePreservation(ctx({ role: "subjectPreservingImage", kind: "image-to-video" }));
    assert.ok(d.refusal);
    assert.match(d.refusal, /image-to-video/);
  });
  it("falls back to guided generation with a reason when the kill-switch is off", () => {
    const d = resolvePreservation(ctx({ role: "subjectPreservingImage", placeSubjectMode: "off" }));
    assert.equal(d.resolved, "source-guided-generation");
    assert.equal(d.actualCapability, "create_media");
    assert.equal(d.evidenceLevel, "source-guided");
    assert.match(d.fallbackReason ?? "", /disabled by operator switch/);
  });
});

describe("product-photo deferral (schema unknown)", () => {
  it("defers to guided generation with a typed reason, never a speculative dispatch", () => {
    assert.equal(isProductPhotoSupported(), false);
    const d = resolvePreservation(ctx({ role: "productPackshot" }));
    assert.equal(d.requested, "product-photo");
    assert.equal(d.resolved, "source-guided-generation");
    assert.equal(d.requestedCapability, "deferred");
    assert.equal(d.actualCapability, "create_media");
    assert.equal(d.evidenceLevel, "source-guided");
    assert.match(d.fallbackReason ?? "", /deferred/i);
    assert.equal(d.refusal, undefined);
  });
});

describe("variation gating (explicit only, never automatic)", () => {
  it("resolves variation for an explicit refinement with a selected output", () => {
    const d = resolvePreservation(ctx({ variationExplicit: true, variationSourceUrl: OUTPUT }));
    assert.equal(d.requested, "variation");
    assert.equal(d.resolved, "variation");
    assert.equal(d.actualCapability, "create_variations");
    // Provenance, never a preservation claim.
    assert.equal(d.evidenceLevel, "none");
  });
  it("a stale variation source without the explicit flag is never a variation request", () => {
    const d = resolvePreservation(ctx({ variationExplicit: false, variationSourceUrl: OUTPUT }));
    assert.equal(d.requested, "source-guided-generation");
    assert.equal(d.resolved, "source-guided-generation");
    assert.equal(d.actualCapability, "create_media");
    assert.equal(d.evidenceLevel, "source-guided");
    // Nothing fell back: the stale URL was simply not a request, so no
    // fallback reason is recorded and the UI shows a clean guided render.
    assert.equal(d.fallbackReason, undefined);
    assert.equal(d.refusal, undefined);
  });
  it("explicit refinements of non-image stages render guided, never refused", () => {
    const d = resolvePreservation(ctx({ kind: "image-to-video", variationExplicit: true, variationSourceUrl: OUTPUT }));
    assert.equal(d.requested, "variation");
    assert.equal(d.resolved, "source-guided-generation");
    assert.equal(d.actualCapability, "create_media");
    assert.match(d.fallbackReason ?? "", /only serve image stages/);
    assert.equal(d.refusal, undefined);
  });
  it("renders guided from the approved source when the selected variation source is unusable", () => {
    const d = resolvePreservation(ctx({ variationExplicit: true, variationSourceUrl: "not-a-url" }));
    // No usable selected source: the request falls back to the role, and the
    // refinement prompt still renders guided - never a blind variation.
    assert.equal(d.resolved, "source-guided-generation");
    assert.equal(d.actualCapability, "create_media");
  });
});

describe("defensive provider-response parsing", () => {
  it("returns the first usable URL and nothing else", () => {
    assert.equal(firstUsableOutput(["https://cdn.example/a.png", "https://cdn.example/b.png"]), "https://cdn.example/a.png");
    assert.equal(firstUsableOutput(["http://cdn.example/a.png", "https://cdn.example/b.png"]), "https://cdn.example/b.png");
  });
  it("malformed or empty responses never claim success", () => {
    assert.equal(firstUsableOutput(undefined), undefined);
    assert.equal(firstUsableOutput(null), undefined);
    assert.equal(firstUsableOutput({ url: "https://cdn.example/a.png" }), undefined);
    assert.equal(firstUsableOutput([]), undefined);
    assert.equal(firstUsableOutput(["", "not-a-url", 42]), undefined);
  });
});

describe("preservation call classification (inline / track / empty)", () => {
  it("inline wins when a usable output URL is present, even with a job id", () => {
    assert.deepEqual(
      classifyPreservationResult(["https://cdn.example/a.png"], "mjob_1"),
      { kind: "inline", url: "https://cdn.example/a.png" }
    );
  });
  it("a valid non-empty async job id tracks without claiming output", () => {
    assert.deepEqual(classifyPreservationResult([], "mjob_1"), { kind: "track", jobId: "mjob_1" });
    assert.deepEqual(classifyPreservationResult(undefined, "  mjob_2  "), { kind: "track", jobId: "mjob_2" });
    assert.deepEqual(classifyPreservationResult(["not-a-url"], "mjob_3"), { kind: "track", jobId: "mjob_3" });
  });
  it("malformed, blank, or handle-less responses are empty, never tracked", () => {
    for (const id of [undefined, null, "", "   ", 42, {}]) {
      const out = classifyPreservationResult([], id);
      assert.equal(out.kind, "empty", JSON.stringify(id));
    }
    const out = classifyPreservationResult({ url: "https://cdn.example/a.png" }, undefined);
    assert.equal(out.kind, "empty");
    assert.match((out as { reason: string }).reason, /no usable output and no provider job id/);
  });
});

describe("stable operation keys (no duplicate paid submissions)", () => {
  it("derives deterministic place/vary keys from the job key", () => {
    const base = "pf_cmp_x_keyframe_job_1";
    assert.equal(preservationOperationKey(base, "place"), `${base}_place`);
    assert.equal(preservationOperationKey(base, "vary"), `${base}_vary`);
    assert.equal(preservationOperationKey(base, "place"), preservationOperationKey(base, "place"));
    assert.notEqual(preservationOperationKey(base, "place"), preservationOperationKey(base, "vary"));
    assert.notEqual(preservationOperationKey(base, "place"), base);
  });
});

describe("provenance persistence (plan → job → receipt vocabulary)", () => {
  it("requestMetaFor carries the plan-time preservation request", () => {
    const meta = requestMetaFor(stage({ role: "productPackshot" }));
    assert.equal(meta.preservationRequested, "product-photo");
    const guided = requestMetaFor(stage({ role: "sourceGuidedImage" }));
    assert.equal(guided.preservationRequested, "source-guided-generation");
    // Initial production never marks explicit variation.
    assert.equal((meta as Record<string, unknown>).variationExplicit, undefined);
  });
  it("provenanceMeta records the resolved decision on the job", () => {
    const decision = resolvePreservation(ctx({ role: "subjectPreservingImage" }));
    const meta = provenanceMeta(stage(), { resolvedInputSource: "approved-source" }, decision);
    assert.equal(meta.preservationRequested, "subject-placement");
    assert.equal(meta.preservationResolved, "subject-placement");
    assert.equal(meta.preservationEvidenceLevel, "subject-preserving");
    assert.equal(meta.preservationRequestedCapability, "place_subject");
    assert.equal(meta.preservationActualCapability, "place_subject");
    assert.equal(meta.approvedSourceAssetId, "src_1");
  });
  it("provenanceMeta without a decision keeps legacy shape", () => {
    const meta = provenanceMeta(stage(), { resolvedInputSource: "approved-source" });
    assert.equal(meta.preservationRequested, undefined);
    assert.equal(meta.role, "sourceGuidedImage");
  });
});

describe("dispatch source ownership (runner context builder)", () => {
  function campaign(over: Partial<Campaign> = {}): Campaign {
    return {
      id: "cmp_x",
      sourceMediaId: "src_1",
      jobs: [],
      preflight: { decision: "allow" } as Campaign["preflight"],
      ...over
    } as Campaign;
  }
  function prodJob(over: Partial<ProductionJob> = {}): ProductionJob {
    return {
      id: "job_1",
      campaignId: "cmp_x",
      stageId: "keyframe",
      kind: "image-to-image",
      capability: "flux-dev",
      prompt: "p",
      startedAt: new Date().toISOString(),
      status: "queued",
      ...over
    } as ProductionJob;
  }
  const media = [{ id: "src_1", url: SOURCE }];

  it("owns the approved source only on byte-for-byte row match", () => {
    const st = stage();
    const ok = preservationContextFor(campaign(), media, st, prodJob(), {
      inputUrl: SOURCE,
      resolvedInputSource: "approved-source"
    });
    assert.equal(ok.ctx.sourceOwnedByCampaign, true);
    const spoofed = preservationContextFor(campaign(), media, st, prodJob(), {
      inputUrl: "https://evil.example/spoof.png",
      resolvedInputSource: "approved-source"
    });
    assert.equal(spoofed.ctx.sourceOwnedByCampaign, false);
  });
  it("owns stage outputs only from jobs in this campaign", () => {
    const st = stage({ inputSource: "stage-output", dependsOnStageIds: ["keyframe"] });
    const ready = prodJob({ id: "job_k", stageId: "keyframe", status: "ready_to_share", providerOutputUrl: OUTPUT, outputUrl: OUTPUT });
    const c = campaign({ jobs: [ready] });
    const ok = preservationContextFor(c, media, st, prodJob({ stageId: "motion" }), {
      inputUrl: OUTPUT,
      resolvedInputSource: "stage-output",
      sourceStageId: "keyframe"
    });
    assert.equal(ok.ctx.sourceOwnedByCampaign, true);
    const foreign = preservationContextFor(campaign(), media, st, prodJob({ stageId: "motion" }), {
      inputUrl: OUTPUT,
      resolvedInputSource: "stage-output",
      sourceStageId: "keyframe"
    });
    assert.equal(foreign.ctx.sourceOwnedByCampaign, false);
  });
  it("drops variation sources that are not campaign outputs", () => {
    const st = stage();
    const job = prodJob({ variationExplicit: true, variationSourceUrl: "https://evil.example/x.png" });
    const { ctx: built } = preservationContextFor(campaign(), media, st, job, {
      inputUrl: SOURCE,
      resolvedInputSource: "approved-source"
    });
    assert.equal(built.variationSourceUrl, undefined);
    // Without a usable selected source the explicit flag alone is not enough.
    const d = resolvePreservation(built);
    assert.notEqual(d.resolved, "variation");
  });
});

describe("legacy compatibility + UI copy", () => {
  it("legacy rows normalize to no claim and render nothing", () => {
    assert.equal(normalizePreservation(undefined).preservationEvidenceLevel, "none");
    assert.equal(normalizePreservation({}).preservationEvidenceLevel, "none");
    assert.equal(preservationIndicator(undefined).label, null);
    assert.equal(preservationIndicator({}).label, null);
  });
  it("labels resolved outcomes honestly (never 'preserved' for guided)", () => {
    assert.equal(preservationIndicator({ preservationEvidenceLevel: "subject-preserving" }).label, "Subject-preserving");
    assert.equal(
      preservationIndicator({ preservationRequested: "product-photo", preservationResolved: "source-guided-generation", preservationEvidenceLevel: "source-guided" }).label,
      "Product-reference guided"
    );
    const guided = preservationIndicator({ preservationEvidenceLevel: "source-guided" });
    assert.equal(guided.label, "Guided by approved reference");
    assert.match(guided.detail, /unclaimed/);
    assert.doesNotMatch(guided.label ?? "", /preserv/i);
  });
  it("surfaces fallback use next to the label", () => {
    const ind = preservationIndicator({ preservationEvidenceLevel: "source-guided", fallbackReason: "place_subject failed" });
    assert.equal(ind.fallbackUsed, true);
    assert.match(ind.detail, /fallback/i);
  });
  it("a fallen-back variation labels what ran (guided), not what was requested", () => {
    const ind = preservationIndicator({
      preservationRequested: "variation",
      preservationResolved: "variation",
      preservationEvidenceLevel: "source-guided",
      preservationActualCapability: "create_media",
      fallbackReason: "Preservation job ended (failed) without an output - rendered as a guided output instead."
    });
    assert.equal(ind.label, "Guided by approved reference");
    assert.equal(ind.fallbackUsed, true);
    assert.match(ind.detail, /fallback/i);
  });
});

describe("source-fidelity modes (product/property-preserving)", () => {
  it("strict stages request subject-placement on image kinds, never product-photo", () => {
    assert.equal(
      requestedPreservationMode({ role: "productPackshot", variationExplicit: false, variationSourceUrl: undefined, kind: "text-to-image", fidelity: "product-preserving" }),
      "subject-placement"
    );
    assert.equal(
      requestedPreservationMode({ role: "sourceGuidedImage", variationExplicit: false, variationSourceUrl: undefined, kind: "image-to-image", fidelity: "property-preserving" }),
      "subject-placement"
    );
    assert.equal(isStrictFidelity("product-preserving"), true);
    assert.equal(isStrictFidelity("property-preserving"), true);
    assert.equal(isStrictFidelity("conceptual"), false);
    assert.equal(isStrictFidelity(undefined), false);
  });

  it("strict stages resolve place_subject with no generic fallback", () => {
    const d = resolvePreservation(ctx({ role: "productPackshot", fidelity: "product-preserving" }));
    assert.equal(d.resolved, "subject-placement");
    assert.equal(d.actualCapability, "place_subject");
    assert.equal(d.allowFallbackToSourceGuided, false);
    assert.equal(d.evidenceLevel, "product-preserving");
    assert.equal(d.refusal, undefined);
    const property = resolvePreservation(ctx({ role: "sourceGuidedImage", fidelity: "property-preserving" }));
    assert.equal(property.resolved, "subject-placement");
    assert.equal(property.evidenceLevel, "property-preserving");
    assert.equal(property.allowFallbackToSourceGuided, false);
  });

  it("strict stages refuse (exact message) when place_subject is switched off", () => {
    const d = resolvePreservation(ctx({ role: "productPackshot", fidelity: "product-preserving", placeSubjectMode: "off" }));
    assert.equal(d.allowFallbackToSourceGuided, false);
    assert.equal(d.refusal, FIDELITY_REFUSAL);
    assert.equal(
      FIDELITY_REFUSAL,
      "Could not preserve the approved product/property. No replacement image was generated."
    );
  });

  it("strict stages refuse motion kinds and variations instead of downgrading", () => {
    const motion = resolvePreservation(ctx({ kind: "image-to-video", fidelity: "product-preserving" }));
    assert.equal(motion.refusal, FIDELITY_REFUSAL);
    assert.equal(motion.allowFallbackToSourceGuided, false);
    const propertyMotion = resolvePreservation(ctx({ kind: "image-to-video", fidelity: "property-preserving" }));
    assert.equal(propertyMotion.refusal, FIDELITY_REFUSAL);
    assert.equal(propertyMotion.allowFallbackToSourceGuided, false);
    const variation = resolvePreservation({
      ...ctx({ fidelity: "product-preserving" }),
      variationExplicit: true,
      variationSourceUrl: OUTPUT
    });
    assert.equal(variation.refusal, FIDELITY_REFUSAL);
  });

  it("conceptual stages keep legacy guided behavior byte-for-byte", () => {
    const d = resolvePreservation(ctx({ role: "sourceGuidedImage" }));
    assert.equal(d.resolved, "source-guided-generation");
    assert.equal(d.allowFallbackToSourceGuided, true);
    assert.equal(d.evidenceLevel, "source-guided");
    const off = resolvePreservation(ctx({ role: "subjectPreservingImage", placeSubjectMode: "off" }));
    assert.equal(off.allowFallbackToSourceGuided, true);
    assert.match(off.fallbackReason ?? "", /operator switch/);
  });
});

describe("fidelity pills (earned labels only)", () => {
  it("labels passed strict outputs as preserved", () => {
    assert.deepEqual(
      fidelityPillFor({ sourceFidelity: "product-preserving", fidelityCheck: "passed", role: "productPackshot", mediaType: "image" }),
      { label: "Product preserved", tone: "emerald" }
    );
    assert.deepEqual(
      fidelityPillFor({ sourceFidelity: "property-preserving", fidelityCheck: "passed", role: "subjectPreservingImage", mediaType: "image" }),
      { label: "Property preserved", tone: "emerald" }
    );
  });

  it("labels failed checks as failed and guided renders as reference-guided", () => {
    assert.deepEqual(
      fidelityPillFor({ sourceFidelity: "product-preserving", fidelityCheck: "failed", role: "productPackshot", mediaType: "image" }),
      { label: "Preservation failed", tone: "rose" }
    );
    assert.deepEqual(
      fidelityPillFor({ fidelityCheck: undefined, role: "sourceGuidedImage", mediaType: "image" }),
      { label: "Reference-guided", tone: "muted" }
    );
    assert.equal(
      REFERENCE_GUIDED_COPY,
      "Reference-guided - exact identity is not guaranteed."
    );
  });

  it("renders no pill for unknown, legacy, concept, motion, or unchecked strict rows", () => {
    assert.equal(fidelityPillFor(null), null);
    assert.equal(fidelityPillFor({ sourceFidelity: "conceptual", role: "conceptImage", mediaType: "image" }), null);
    assert.equal(fidelityPillFor({ sourceFidelity: "conceptual", role: "sourceGuidedImage", mediaType: "video" }), null);
    assert.equal(
      fidelityPillFor({ sourceFidelity: "product-preserving", role: "productPackshot", mediaType: "image" }),
      null,
      "strict success without a recorded check claims nothing"
    );
  });
});
