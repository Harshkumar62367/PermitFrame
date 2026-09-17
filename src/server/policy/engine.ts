import type {
  Campaign,
  PermissionPassport,
  PreflightBlocker,
  PreflightDecision,
  ProductFacts,
  Transformation
} from "../types";
import { getDkg } from "../dkg";
import { findApplicablePassportsSparql, findProductFactsSparql } from "../dkg/sparql";
import { resolvePlanCapabilities } from "../livepeer/catalogue";

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
        message: `No verified product facts found for ${campaign.brand} ${campaign.productName} — no advertising claim can be supported.`,
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
 * Production plan from live Livepeer discovery. Precedence for each
 * capability: explicit env config (operator intent) → catalogue pick from
 * capabilities the MCP server reports as available → verified default.
 * Discovery failure never blocks preflight — the plan falls back silently
 * and each job persists the exact capability it actually ran.
 */
async function buildPlan(campaign: Campaign): Promise<PreflightDecision["plan"]> {
  const resolved = await resolvePlanCapabilities();
  const imageCap = process.env.LIVEPEER_IMAGE_CAPABILITY ?? resolved.image;
  const videoCap = process.env.LIVEPEER_VIDEO_CAPABILITY ?? resolved.video;
  const stages: PreflightDecision["plan"] = [
    {
      id: "keyframe",
      kind: "text-to-image",
      capability: imageCap,
      label: "Campaign keyframe (9:16)",
      format: "9:16"
    },
    {
      id: "square-variation",
      kind: "image-to-image",
      capability: imageCap,
      label: "Square feed variation (1:1)",
      format: "1:1"
    },
    {
      id: "header-169",
      kind: "image-to-image",
      capability: imageCap,
      label: "Campaign header (16:9)",
      format: "16:9"
    }
  ];
  if (campaign.request.transformation === "video") {
    stages.push({
      id: "motion",
      kind: "image-to-video",
      capability: videoCap,
      label: "Short vertical video (9:16, 5s)",
      format: "9:16"
    });
  }
  return stages;
}

export function composeStagePrompt(campaign: Campaign, stageId: string): string {
  const decision = campaign.preflight;
  const brief = campaign.request.creativeBrief.trim().replace(/\s+/g, " ");
  const constraints = (decision?.promptConstraints ?? []).join(" ");
  if (stageId === "keyframe") {
    return `Advertising keyframe for ${campaign.brand} ${campaign.productName}: ${brief}. Vertical 9:16 composition. ${constraints}`;
  }
  if (stageId === "square-variation") {
    return `Square 1:1 social variation of this campaign keyframe for ${campaign.brand}: same product, balanced centered composition. ${constraints}`;
  }
  if (stageId === "header-169") {
    return `Wide 16:9 campaign header banner for ${campaign.brand} ${campaign.productName}: ${brief}. Centered product, breathing room for headlines on both sides. ${constraints}`;
  }
  return `Smooth cinematic motion on this product scene: gentle camera push-in, natural light. Keep the product sharp and central. ${constraints}`;
}
