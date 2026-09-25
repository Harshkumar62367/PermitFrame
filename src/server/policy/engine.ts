import type {
  Campaign,
  PermissionPassport,
  PreflightBlocker,
  PreflightDecision,
  ProductFacts,
  QualityProfile,
  Transformation
} from "../types";
import { getDkg } from "../dkg";
import { findApplicablePassportsSparql, findProductFactsSparql } from "../dkg/sparql";
import { resolvePlanRolesLive } from "../livepeer/catalogue";
import { normalizeQualityProfile } from "../livepeer/plan-dag";
import {
  buildTemplateStages,
  findRecipeAnywhere,
  getTemplate,
  toPlanStages,
  type TemplateSelection
} from "../livepeer/templates";

/**
 * The preflight engine compiles creator permissions + verified product facts
 * into an enforceable decision: whether Livepeer generation may run, which
 * capabilities may be used, and which constraints the prompts must carry.
 * This is where DKG knowledge changes agent behavior.
 */

export async function preflight(campaign: Campaign): Promise<PreflightDecision> {
  const dkg = getDkg();
  const today = new Date().toISOString().slice(0, 10);
  const { platform, country, requestedClaims, transformation, creativeBrief } = campaign.request;

  // 1. Query the graph for rights applicable to this exact request.
  const applicable = await dkg.findApplicablePassports({
    creatorId: campaign.creatorId,
    platform,
    country,
    onDate: today
  });

  // 2. Query verified product facts for this brand/product.
  const facts = await dkg.findProductFacts(campaign.brand, campaign.productName);

  const blockers: PreflightBlocker[] = [];
  const passport: PermissionPassport | undefined = applicable[0];

  if (!passport) {
    blockers.push(...(await diagnoseWhyNoPassport(campaign, today)));
  } else {
    // animation/modification check (applicable passport exists, so platform,
    // country and validity already passed in the SPARQL filter)
    const needsAnimate = transformation === "video";
    const needsEdit = true; // every derivative is a modification of the source
    if (needsEdit && !passport.allowedTransformations.includes("edit" as Transformation)) {
      blockers.push({
        code: "TRANSFORMATION_NOT_PERMITTED",
        message: `Permission passport ${passport.id} does not allow editing the creator's content.`,
        evidenceRefs: [passport.id]
      });
    } else if (needsAnimate && !passport.allowedTransformations.includes("animate" as Transformation)) {
      blockers.push({
        code: "TRANSFORMATION_NOT_PERMITTED",
        message: `Permission passport ${passport.id} does not allow animating the creator's content into video.`,
        evidenceRefs: [passport.id]
      });
    }
  }

  // 3. Claim verification against approved/prohibited facts.
  const allowedClaims: string[] = [];
  if (!facts) {
    if (requestedClaims.length > 0) {
      blockers.push({
        code: "CLAIM_NOT_SUPPORTED",
        message: `No verified product facts found for ${campaign.brand} ${campaign.productName} - no advertising claim can be supported.`,
        evidenceRefs: []
      });
    }
  } else {
    for (const claim of requestedClaims) {
      const normalized = claim.toLowerCase();
      const prohibited = facts.prohibitedClaims.some((c) => c.toLowerCase() === normalized);
      const approved = facts.approvedClaims.some((c) => c.toLowerCase() === normalized);
      if (prohibited) {
        blockers.push({
          code: "CLAIM_PROHIBITED",
          message: `"${claim}" is on the prohibited-claims list for ${campaign.productName}.`,
          evidenceRefs: [facts.id]
        });
      } else if (!approved) {
        blockers.push({
          code: "CLAIM_NOT_SUPPORTED",
          message: `"${claim}" is not supported by any verified product fact for ${campaign.productName}.`,
          evidenceRefs: [facts.id]
        });
      } else {
        allowedClaims.push(claim);
      }
    }
  }

  // 4. Compile the constrained production brief.
  const promptConstraints = compileConstraints(facts, allowedClaims, passport);

  // 5. Plan the Livepeer production pipeline (only reachable when allowed).
  const plan = await buildPlan(campaign);

  return {
    decision: blockers.length === 0 ? "allow" : "block",
    checkedAt: new Date().toISOString(),
    blockers,
    allowedClaims,
    promptConstraints,
    plan,
    queriedRights: applicable.map((p) => p.ual ?? p.id),
    queriedFacts: facts ? [facts.ual ?? facts.id] : [],
    sparqlPreview: [
      "-- Rights query executed against the DKG:",
      findApplicablePassportsSparql(campaign.creatorId, platform, country, today),
      "",
      "-- Product facts query:",
      findProductFactsSparql(campaign.brand, campaign.productName)
    ].join("\n")
  };

  async function diagnoseWhyNoPassport(c: Campaign, onDate: string): Promise<PreflightBlocker[]> {
    // Produce precise, human-readable reasons by diffing against all of the
    // creator's passports rather than one vague "not permitted".
    const all = await getDkg().listPassports(c.creatorId);
    if (all.length === 0) {
      return [
        {
          code: "PLATFORM_NOT_PERMITTED",
          message: `No permission passport exists for creator ${c.creatorId}.`,
          evidenceRefs: []
        }
      ];
    }
    const reasons: PreflightBlocker[] = [];
    const platformOk = all.some((p) => p.platforms.some((x) => x.toLowerCase() === platform.toLowerCase()));
    const countryOk = all.some((p) => p.countries.some((x) => x.toLowerCase() === country.toLowerCase()));
    const notExpired = all.some((p) => p.validUntil >= onDate);
    const notRevoked = all.some((p) => p.status !== "revoked");
    if (!platformOk) {
      reasons.push({
        code: "PLATFORM_NOT_PERMITTED",
        message: `${platform} is not in any of this creator's permission passports (permitted: ${[
          ...new Set(all.flatMap((p) => p.platforms))
        ].join(", ")}).`,
        evidenceRefs: all.map((p) => p.id)
      });
    }
    if (!countryOk) {
      reasons.push({
        code: "COUNTRY_NOT_PERMITTED",
        message: `${country} is not covered by any of this creator's permission passports (covered: ${[
          ...new Set(all.flatMap((p) => p.countries))
        ].join(", ")}).`,
        evidenceRefs: all.map((p) => p.id)
      });
    }
    if (!notExpired) {
      reasons.push({
        code: "PERMISSION_EXPIRED",
        message: `All of this creator's permissions expired (latest validUntil: ${all
          .map((p) => p.validUntil)
          .sort()
          .at(-1)}).`,
        evidenceRefs: all.map((p) => p.id)
      });
    }
    if (!notRevoked) {
      reasons.push({
        code: "PERMISSION_REVOKED",
        message: "The creator's permission has been revoked.",
        evidenceRefs: all.map((p) => p.id)
      });
    }
    return reasons;
  }
}

function compileConstraints(
  facts: ProductFacts | null,
  allowedClaims: string[],
  passport: PermissionPassport | undefined
): string[] {
  const constraints: string[] = [];
  if (passport) {
    constraints.push(
      `Creator ${passport.creatorName} has permitted this usage through ${passport.validUntil} for ${passport.countries.join(", ")}.`
    );
  }
  if (facts) {
    constraints.push(...facts.guidelines);
    if (allowedClaims.length > 0) {
      constraints.push(`You may state exactly these verified claims: ${allowedClaims.join("; ")}.`);
    }
    if (facts.prohibitedClaims.length > 0) {
      constraints.push(`Do not depict, imply or state: ${facts.prohibitedClaims.join("; ")}.`);
    }
  }
  constraints.push("No text overlays with product claims unless listed as verified claims.");
  return constraints;
}

/**
 * Template-driven plan from a validated production spec. Role capabilities
 * resolve live per the requested profile; unknown/stale specs fall back to
 * the default pack (null) rather than failing preflight.
 */
async function buildTemplatePlan(
  spec: TemplateSelection | undefined,
  profile: QualityProfile
): Promise<PreflightDecision["plan"] | null> {
  if (!spec) return null;
  const template = getTemplate(spec.templateId);
  if (!template) return null;
  const effectiveProfile = normalizeQualityProfile(spec.qualityProfile ?? profile);
  if (!template.compatibleProfiles.includes(effectiveProfile)) return null;
  const roles = await resolvePlanRolesLive(effectiveProfile);
  const quickRoles = spec.packSize === "quick" ? await resolvePlanRolesLive("draft") : null;
  const quickImage = quickRoles && (quickRoles.conceptImage.source === "discovered" || quickRoles.conceptImage.source === "configured")
    ? quickRoles.conceptImage.capability
    : undefined;
  const conceptImage = quickImage && quickImage !== roles.conceptImage.capability
    ? { ...roles.conceptImage, capability: quickImage, fallbackFrom: `${roles.conceptImage.capability ?? "automatic"} → ${quickImage}` }
    : roles.conceptImage;
  const byRole = {
    conceptImage,
    sourceGuidedImage: conceptImage,
    subjectPreservingImage: roles.subjectPreservingImage,
    productPackshot: roles.productPackshot,
    imageToVideo: roles.imageToVideo,
    upscale: roles.upscale,
    tts: roles.tts,
    music: roles.music,
    subtitle: roles.subtitle,
    critic: roles.critic
  } as const;
  const built = buildTemplateStages(template, { ...spec, qualityProfile: effectiveProfile }, (role) => {
    const resolved = byRole[role];
    // Source-guided variations ride the concept pick so siblings stay on
    // one model per run; every other role uses its own resolution.
    const capability = resolved.capability ?? "flux-dev";
    return { capability, ...(resolved.fallbackFrom ? { fallbackFrom: resolved.fallbackFrom } : {}) };
  });
  // A validated spec always closes; a stale one falls back to the default
  // pack rather than failing preflight.
  if (!built.ok) return null;
  return toPlanStages(built.plan, effectiveProfile);
}

/**
 * Production plan as an explicit DAG from live Livepeer discovery. Each
 * capability resolves per the requested quality profile (draft / balanced /
 * premium): explicit env config (operator intent) → currently-available
 * preference → verified default. Discovery failure never blocks preflight -
 * the plan falls back silently and each job persists the exact capability it
 * actually ran plus the requested profile.
 *
 * Input discipline: the keyframe and every format variation derive
 * independently from the approved source media (no sibling chaining - a 1:1
 * never derives from the 9:16 output); the motion stage depends only on its
 * keyframe.
 */
async function buildPlan(campaign: Campaign): Promise<PreflightDecision["plan"]> {
  const profile = normalizeQualityProfile(
    campaign.request.qualityProfile ?? process.env.LIVEPEER_QUALITY_PROFILE
  );
  // Template-driven plans replace the rigid default pack whenever the
  // campaign carries a validated production spec. The default pack below
  // stays for legacy rows without one.
  const templatePlan = await buildTemplatePlan(campaign.request.productionSpec, profile);
  if (templatePlan) return templatePlan;
  const roles = await resolvePlanRolesLive(profile);
  const imageCap = roles.conceptImage.capability ?? "flux-dev";
  const videoCap = roles.imageToVideo.capability ?? "kling-v3-turbo-i2v";
  const imageFallback = roles.conceptImage.fallbackFrom;
  const videoFallback = roles.imageToVideo.fallbackFrom;
  const imageStage = (
    id: string,
    kind: "text-to-image" | "image-to-image",
    label: string,
    format: "9:16" | "4:3" | "1:1" | "16:9"
  ): PreflightDecision["plan"][number] => ({
    id,
    kind,
    capability: imageCap,
    label,
    format,
    dependsOnStageIds: [],
    inputSource: "approved-source",
    qualityProfile: profile,
    // Format variations are guided by the approved source, not derived from
    // the keyframe - exact product/logo preservation is unclaimed until a
    // dedicated subject-edit adapter is wired.
    role: kind === "text-to-image" ? "conceptImage" : "sourceGuidedImage",
    ...(imageFallback ? { fallbackFrom: imageFallback } : {})
  });
  const stages: PreflightDecision["plan"] = [
    imageStage("keyframe", "text-to-image", "Campaign keyframe (9:16)", "9:16"),
    imageStage("square-variation", "image-to-image", "Square feed variation (1:1)", "1:1"),
    imageStage("header-169", "image-to-image", "Campaign header (16:9)", "16:9")
  ];
  if (campaign.request.transformation === "video") {
    stages.push({
      id: "motion",
      kind: "image-to-video",
      capability: videoCap,
      label: "Short vertical video (9:16, 5s)",
      format: "9:16",
      dependsOnStageIds: ["keyframe"],
      inputSource: "stage-output",
      qualityProfile: profile,
      role: "imageToVideo",
      durationSeconds: 5,
      ...(videoFallback ? { fallbackFrom: videoFallback } : {})
    });
  }
  return stages;
}

export function composeStagePrompt(campaign: Campaign, stageId: string): string {
  const decision = campaign.preflight;
  const brief = campaign.request.creativeBrief.trim().replace(/\s+/g, " ");
  const constraints = (decision?.promptConstraints ?? []).join(" ");
  // Template recipes carry their own prompt scaffolds (quality rules and
  // disclosure-safe wording per vertical); the legacy pack uses the fixed
  // prompts below.
  const found = findRecipeAnywhere(stageId);
  let base: string;
  if (found) {
    const scaffold = found.template.promptScaffolds[found.recipe.promptKey];
    if (scaffold) {
      base = scaffold({
        brand: campaign.brand,
        productName: campaign.productName,
        brief,
        constraints: decision?.promptConstraints ?? []
      });
    } else {
      base = `Smooth cinematic motion on this product scene: gentle camera push-in, natural light. Keep the product sharp and central. ${constraints}`;
    }
  } else if (stageId === "keyframe") {
    base = `Advertising keyframe for ${campaign.brand} ${campaign.productName}: ${brief}. Vertical 9:16 composition. ${constraints}`;
  } else if (stageId === "square-variation") {
    base = `Square 1:1 social creative for ${campaign.brand}, independently composed from the approved source and campaign brief: same product, balanced centered composition, guided by the approved source. ${constraints}`;
  } else if (stageId === "header-169") {
    base = `Wide 16:9 campaign header banner for ${campaign.brand} ${campaign.productName}, independently composed from the approved source and campaign brief: centered product, breathing room for headlines on both sides, guided by the approved source. ${constraints}`;
  } else {
    base = `Smooth cinematic motion on this product scene: gentle camera push-in, natural light. Keep the product sharp and central. ${constraints}`;
  }
  // Strict shape discipline, resolved from the plan (not the label): the
  // aspect_ratio dispatch param asks, this line insists — providers that
  // weigh prompt text over parameters still deliver the planned frame.
  const format = decision?.plan.find((s) => s.id === stageId)?.format;
  const strict = format ? STRICT_ASPECT_LINE[format] : undefined;
  return strict ? `${base} ${strict}` : base;
}

/**
 * Per-format strict output-shape directives. Appended to every dispatched
 * prompt: fill the frame edge to edge, never bars, crops, or padding.
 */
const STRICT_ASPECT_LINE: Record<string, string> = {
  "9:16":
    "Strict output shape: vertical 9:16 portrait, taller than wide. Compose natively in 9:16 and fill the entire frame edge to edge — no letterboxing, no pillarboxing, no square crop, no borders or padding.",
  "1:1":
    "Strict output shape: exact 1:1 square. Compose natively square with the subject centered and fully inside a full-bleed square frame — no bars, no portrait or landscape crop, no borders or padding.",
  "16:9":
    "Strict output shape: wide 16:9 landscape, wider than tall. Compose natively in 16:9 and fill the entire frame edge to edge, breathing room left and right — no letterboxing, no pillarboxing, no square crop, no borders or padding.",
  "4:3":
    "Strict output shape: 4:3 standard landscape, slightly wider than tall. Compose natively in 4:3 and fill the entire frame edge to edge — no letterboxing, no pillarboxing, no square crop, no borders or padding."
};
