import crypto from "node:crypto";
import { explorerUrlFor } from "./dkg/adapter";
import type {
  Campaign,
  PermissionPassport,
  ProductFacts,
  PublicVerificationSnapshot
} from "./types";

/** High-entropy public reference (144 bits). Unpredictable by design. */
export function newVerificationRef(): string {
  return `vrf_${crypto.randomBytes(18).toString("hex")}`;
}

/**
 * Pure builder: sanitized public snapshot from already-approved workspace
 * data. Contains ONLY intentional public fields. UAL/explorer are set only
 * when the campaign record genuinely anchored - never from ID shape.
 * Throws for non-approved campaigns so no future caller can publish a
 * "verified" snapshot of a draft, blocked, or archived pack.
 * Unit-tested for field leakage and anchored honesty. No I/O, no session.
 */
export function buildPublicSnapshot(input: {
  ref: string;
  campaign: Campaign;
  passport: PermissionPassport | null;
  facts: ProductFacts | null;
}): PublicVerificationSnapshot {
  const { ref, campaign, passport, facts } = input;
  if (campaign.status !== "approved") {
    throw new Error("Public verification snapshots require an approved campaign pack.");
  }
  const anchored = campaign.publicationStatus === "anchored" && !!campaign.campaignUAL;
  return {
    ref,
    campaignId: campaign.id,
    title: campaign.title,
    brand: campaign.brand,
    productName: campaign.productName,
    platform: campaign.request.platform,
    country: campaign.request.country,
    status: "approved",
    approvedAt: campaign.updatedAt,
    creatorName: passport?.creatorName ?? "Creator",
    rightsSummary: {
      platforms: passport?.platforms ?? [campaign.request.platform],
      countries: passport?.countries ?? [campaign.request.country],
      validUntil: passport?.validUntil ?? "",
      status: passport?.status ?? "unknown"
    },
    verifiedClaims: campaign.preflight?.allowedClaims ?? [],
    brandRules: {
      brand: campaign.brand,
      productName: campaign.productName,
      approvedClaims: facts?.approvedClaims ?? []
    },
    captions: (campaign.captions ?? []).map((c) => ({
      platform: c.platform,
      text: c.text,
      claimsUsed: c.claimsUsed,
      disclosure: c.disclosure
    })),
    outputs: campaign.receipts.map((r) => ({
      id: r.id,
      label: r.label,
      mediaType: r.mediaType,
      format: r.format,
      outputUrl: r.outputUrl,
      ...(r.actualWidth !== undefined && r.actualHeight !== undefined
        ? { actualWidth: r.actualWidth, actualHeight: r.actualHeight }
        : {}),
      ...(r.aspectVerdict ? { aspectVerdict: r.aspectVerdict } : {}),
      // Correlation-only URL fingerprint (legacy rows carry outputHash of the
      // same meaning). Never content evidence - see types.
      providerUrlFingerprint: r.providerUrlFingerprint ?? r.outputHash,
      capability: r.capability,
      promptHash: r.promptHash,
      claimsUsed: r.claimsUsed,
      generatedAt: r.generatedAt
    })),
    publicationStatus: campaign.publicationStatus ?? null,
    ual: anchored ? (campaign.campaignUAL as string) : null,
    explorerUrl: anchored ? explorerUrlFor(campaign.campaignUAL as string) : null
  };
}
