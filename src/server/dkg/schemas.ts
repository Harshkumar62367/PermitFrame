import crypto from "node:crypto";
import type {
  DerivativeReceipt,
  PermissionPassport,
  ProductFacts,
  SourceMedia,
  Campaign,
  Platform,
  Transformation
} from "../types";

// PermitFrame Knowledge Asset vocabulary.
// schema.org provides the base context; pf: is our application namespace.
export const PF_NS = "https://permitframe.app/ns#";
export const PF_CONTEXT: Record<string, string> = {
  schema: "https://schema.org/",
  pf: PF_NS,
  xsd: "http://www.w3.org/2001/XMLSchema#"
};

/** Source-media URN prefix for KA references (`pf:sourceMedia` values). */
export const MEDIA_URN_PREFIX = "urn:permitframe:media:";

/**
 * Reduce a pf:sourceMedia reference to its bare media id. Accepts the
 * canonical URN (optionally wrapped in angle brackets, as CLI tables may
 * render); anything else returns null so unknown references never
 * authorize - callers fail closed on unparseable values.
 */
export function mediaIdFromUrn(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const urn = value.trim().replace(/^<|>$/g, "");
  if (!urn.startsWith(MEDIA_URN_PREFIX)) return null;
  const id = urn.slice(MEDIA_URN_PREFIX.length);
  return id.length > 0 ? id : null;
}

export interface KaEnvelope {
  name: string;
  content: Record<string, unknown>;
}

/**
 * Knowledge Asset 1: Creator Permission Passport.
 * Privacy: minimized on purpose - no contact details, no contract text,
 * no raw personal data. Only the enforceable policy surface.
 */
export function passportKa(passport: PermissionPassport): KaEnvelope {
  return {
    name: `permitframe-passport-${passport.id}`,
    content: {
      "@context": PF_CONTEXT,
      "@id": `urn:permitframe:passport:${passport.id}`,
      "@type": "PermitFramePermissionPassport",
      "schema:name": `Permission Passport - ${passport.creatorName}`,
      "pf:creatorId": passport.creatorId,
      "pf:creatorName": passport.creatorName,
      "pf:platform": passport.platforms,
      "pf:country": passport.countries,
      "pf:allowedTransformation": passport.allowedTransformations,
      "pf:validFrom": passport.validFrom,
      "pf:validUntil": passport.validUntil,
      "pf:status": passport.status,
      "pf:attestationMethod": passport.attestation.method,
      "pf:attestedAt": passport.attestation.consentedAt,
      "pf:declaration": passport.attestation.declaration,
      "pf:sourceMedia": passport.sourceMediaIds.map((id) => ({ "@id": `urn:permitframe:media:${id}` })),
      "pf:visibility": passport.visibility
    }
  };
}

/** Knowledge Asset 2: Verified Product Facts (approved + prohibited claims). */
export function productFactsKa(facts: ProductFacts): KaEnvelope {
  return {
    name: `permitframe-product-facts-${facts.id}`,
    content: {
      "@context": PF_CONTEXT,
      "@id": `urn:permitframe:product-facts:${facts.id}`,
      "@type": "PermitFrameProductFacts",
      "schema:name": `Product Facts - ${facts.brand} ${facts.productName}`,
      "pf:brand": facts.brand,
      "pf:productName": facts.productName,
      "pf:approvedClaim": facts.approvedClaims,
      "pf:prohibitedClaim": facts.prohibitedClaims,
      "pf:brandGuideline": facts.guidelines,
      "pf:evidenceNotes": facts.evidenceNotes,
      "pf:visibility": facts.visibility
    }
  };
}

/** Knowledge Asset 3: Source Media Record (reference + hash, never the bytes). */
export function sourceMediaKa(media: SourceMedia): KaEnvelope {
  const uploaded = media.source === "upload";
  return {
    name: `permitframe-source-media-${media.id}`,
    content: {
      "@context": PF_CONTEXT,
      "@id": `urn:permitframe:media:${media.id}`,
      "@type": "PermitFrameSourceMedia",
      "schema:name": `Permission Passport - ${media.title}`,
      "pf:creatorId": media.creatorId,
      "pf:mediaType": media.type,
      // URL registrations publish the reference URL. Uploaded originals are
      // private workspace copies: no reference URL, public id, or delivery
      // URL ever enters the record - only the byte hash and the storage
      // classification. The asset stays private either way.
      ...(uploaded ? { "pf:storageClass": "private-workspace-copy" } : { "pf:referenceUrl": media.url }),
      // URL registrations fingerprint the reference string (source bytes stay
      // with the creator by design); uploads fingerprint the stored bytes.
      "pf:referenceFingerprint": media.hash,
      "pf:visibility": "private"
    }
  };
}

/** Knowledge Asset 4: Campaign Production Record. */
export function campaignKa(campaign: Campaign): KaEnvelope {
  return {
    name: `permitframe-campaign-${campaign.id}`,
    content: {
      "@context": PF_CONTEXT,
      "@id": `urn:permitframe:campaign:${campaign.id}`,
      "@type": "PermitFrameCampaign",
      "schema:name": campaign.title,
      "pf:brand": campaign.brand,
      "pf:productName": campaign.productName,
      "pf:platform": campaign.request.platform,
      "pf:country": campaign.request.country,
      "pf:requestedClaim": campaign.request.requestedClaims,
      "pf:creativeBriefHash": briefHash(campaign.request.creativeBrief),
      "pf:sourceMedia": { "@id": `urn:permitframe:media:${campaign.sourceMediaId}` },
      "pf:permissionPassport": { "@id": `urn:permitframe:passport:${campaign.passportId}` },
      "pf:productFacts": { "@id": `urn:permitframe:product-facts:${campaign.productFactsId}` },
      "pf:status": campaign.status,
      "pf:visibility": "shared"
    }
  };
}

/** Knowledge Asset 5: Derivative Receipt - one per generated output. */
export function receiptKa(receipt: DerivativeReceipt): KaEnvelope {
  return {
    name: `permitframe-receipt-${receipt.id}`,
    content: {
      "@context": PF_CONTEXT,
      "@id": `urn:permitframe:receipt:${receipt.id}`,
      "@type": "PermitFrameDerivativeReceipt",
      "schema:name": `Derivative Receipt - ${receipt.label}`,
      "pf:campaign": { "@id": `urn:permitframe:campaign:${receipt.campaignId}` },
      "pf:jobId": receipt.jobId,
      "pf:mediaType": receipt.mediaType,
      "pf:format": receipt.format,
      "pf:outputUrl": receipt.outputUrl,
      // Correlation only: fingerprints the provider URL string, never byte
      // content. Durable proof references are the delivery URL + storage
      // identity below plus job provenance - fingerprints prove nothing
      // about the media bytes (a future byte-stream SHA-256 can add
      // cryptographic identity).
      ...(receipt.providerUrlFingerprint ?? receipt.outputHash
        ? { "pf:providerUrlFingerprint": receipt.providerUrlFingerprint ?? receipt.outputHash }
        : {}),
      ...(receipt.storagePublicId ? { "pf:storagePublicId": receipt.storagePublicId } : {}),
      ...(receipt.storageUrl ? { "pf:deliveryUrl": receipt.storageUrl } : {}),
      "pf:generationCapability": receipt.capability,
      "pf:promptHash": receipt.promptHash,
      ...(receipt.actualWidth !== undefined && receipt.actualHeight !== undefined
        ? { "pf:actualWidth": receipt.actualWidth, "pf:actualHeight": receipt.actualHeight }
        : {}),
      ...(receipt.aspectVerdict ? { "pf:aspectVerdict": receipt.aspectVerdict } : {}),
      "pf:claimsUsed": receipt.claimsUsed,
      "pf:derivedFromSourceMedia": { "@id": `urn:permitframe:media:${receipt.derivedFrom.sourceMediaId}` },
      "pf:derivedFromPassport": { "@id": `urn:permitframe:passport:${receipt.derivedFrom.passportId}` },
      "pf:derivedFromProductFacts": { "@id": `urn:permitframe:product-facts:${receipt.derivedFrom.productFactsId}` },
      "pf:generatedAt": receipt.generatedAt,
      "pf:generationCostUsd": receipt.costUsd ?? null,
      "pf:visibility": receipt.visibility
    }
  };
}

/** Knowledge Asset 6: Permission Amendment / Revocation. */
export function amendmentKa(
  passport: PermissionPassport,
  change: { kind: "revoked" | "amended"; note: string; at: string }
): KaEnvelope {
  return {
    name: `permitframe-amendment-${passport.id}-${Date.now()}`,
    content: {
      "@context": PF_CONTEXT,
      "@id": `urn:permitframe:amendment:${passport.id}:${change.at}`,
      "@type": "PermitFramePermissionAmendment",
      "schema:name": `Permission ${change.kind} - ${passport.creatorName}`,
      "pf:amendsPassport": { "@id": `urn:permitframe:passport:${passport.id}` },
      "pf:changeKind": change.kind,
      "pf:note": change.note,
      "pf:effectiveAt": change.at,
      "pf:visibility": "public"
    }
  };
}

export function platformEnum(): Platform[] {
  return ["instagram", "tiktok", "youtube", "linkedin"];
}

export function transformationEnum(): Transformation[] {
  return ["edit", "animate", "upscale", "crop"];
}

export function briefHash(brief: string): string {
  // prompts may contain private creative direction; only the hash is published
  return crypto.createHash("sha256").update(brief).digest("hex").slice(0, 32);
}
