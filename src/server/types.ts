// PermitFrame domain model.
// Knowledge Asset payloads are built from these types in server/dkg/schemas.ts.

export type Platform = "instagram" | "tiktok" | "youtube" | "linkedin";
export type CountryCode = string; // ISO 3166-1 alpha-2, e.g. "GR"
export type Transformation = "edit" | "animate" | "upscale" | "crop";
export type Visibility = "private" | "shared" | "public";

export interface Creator {
  id: string;
  name: string;
  handle: string;
}

/**
 * Creator-attested permission. The creator consents via a consent link;
 * PermitFrame records the declaration and its integrity — it does not prove
 * the creator legally owns every right they grant.
 */
export interface PermissionPassport {
  id: string;
  creatorId: string;
  creatorName: string;
  sourceMediaIds: string[];
  platforms: Platform[];
  countries: CountryCode[];
  allowedTransformations: Transformation[];
  validFrom: string; // ISO date
  validUntil: string; // ISO date
  status: "active" | "revoked" | "superseded";
  attestation: {
    method: "creator-consent-link";
    consentedAt: string;
    declaration: string;
  };
  visibility: Visibility;
  ual?: string; // set once published to DKG
}

export interface SourceMedia {
  id: string;
  creatorId: string;
  title: string;
  type: "video" | "image";
  url: string;
  hash: string; // sha256 of reference bytes/URL at registration
  ual?: string;
}

export interface ProductFacts {
  id: string;
  brand: string;
  productName: string;
  approvedClaims: string[];
  prohibitedClaims: string[];
  guidelines: string[]; // style/brand rules injected into prompts
  evidenceNotes: string; // where the facts came from (spec sheet, lab test...)
  visibility: Visibility;
  ual?: string;
}

export interface CampaignRequest {
  platform: Platform;
  country: CountryCode;
  requestedClaims: string[];
  transformation: "image" | "video";
  creativeBrief: string;
}

export type CampaignStatus = "draft" | "blocked" | "generating" | "review" | "approved";

export interface PreflightBlocker {
  code:
    | "PLATFORM_NOT_PERMITTED"
    | "COUNTRY_NOT_PERMITTED"
    | "PERMISSION_EXPIRED"
    | "PERMISSION_REVOKED"
    | "TRANSFORMATION_NOT_PERMITTED"
    | "CLAIM_NOT_SUPPORTED"
    | "CLAIM_PROHIBITED";
  message: string;
  evidenceRefs: string[]; // passport/fact ids that produced this blocker
}

export interface ProductionStagePlan {
  id: string;
  kind: "text-to-image" | "image-to-image" | "image-to-video" | "upscale" | "audio-to-text";
  capability: string;
  label: string;
  format: "9:16" | "1:1" | "16:9";
}

export interface PreflightDecision {
  decision: "allow" | "block";
  checkedAt: string;
  blockers: PreflightBlocker[];
  allowedClaims: string[];
  promptConstraints: string[]; // compiled from guidelines + claims
  plan: ProductionStagePlan[];
  queriedRights: string[]; // passport UALs/ids consulted
  queriedFacts: string[]; // product facts UALs/ids consulted
  sparqlPreview: string; // the SPARQL the real adapter runs (transparency)
}

export interface ProductionJob {
  id: string;
  campaignId: string;
  stageId: string;
  kind: ProductionStagePlan["kind"];
  capability: string;
  prompt: string;
  status: "queued" | "running" | "succeeded" | "failed";
  error?: string;
  outputUrl?: string;
  outputHash?: string;
  livepeerJobId?: string;
  costUsd?: number;
  humanSummary?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface DerivativeReceipt {
  id: string;
  campaignId: string;
  jobId: string;
  label: string;
  mediaType: "image" | "video";
  format: string;
  outputUrl: string;
  outputHash: string;
  capability: string;
  promptHash: string;
  claimsUsed: string[];
  derivedFrom: {
    sourceMediaId: string;
    passportId: string;
    productFactsId: string;
  };
  generatedAt: string;
  costUsd?: number;
  visibility: Visibility;
  ual?: string;
  ualExplorer?: string;
}

export interface CampaignComment {
  id: string;
  author: string; // "manager" | "client" | "system"
  text: string;
  at: string;
}

export interface CampaignCaption {
  platform: Platform;
  text: string;
  claimsUsed: string[];
  disclosure: string;
}

export interface Campaign {
  id: string;
  title: string;
  brand: string;
  productName: string;
  request: CampaignRequest;
  status: CampaignStatus;
  campaignUAL?: string; // set once the campaign record is published to DKG
  preflight?: PreflightDecision;
  jobs: ProductionJob[];
  receipts: DerivativeReceipt[];
  creatorId: string;
  sourceMediaId: string;
  passportId: string;
  productFactsId: string;
  comments: CampaignComment[];
  captions: CampaignCaption[];
  shareToken?: string;
  createdAt: string;
  updatedAt: string;
  demoNote?: string; // narrative for the seeded demo campaigns
}

export interface ConsentDraft {
  // what the creator sees/edits on the consent page before attesting
  creatorId: string;
  platforms: Platform[];
  countries: CountryCode[];
  allowedTransformations: Transformation[];
  validUntil: string;
  sourceMediaIds: string[];
}

export interface Database {
  creators: Creator[];
  passports: PermissionPassport[];
  sourceMedia: SourceMedia[];
  productFacts: ProductFacts[];
  campaigns: Campaign[];
  consentInvites: { token: string; creatorId: string; draft: ConsentDraft; status: "pending" | "completed" }[];
  events: AuditEvent[];
}

/** Rough per-capability price map (USD) used for pre-production estimates.
 *  Live figures come from the network's billing fields; these defaults match
 *  observed pricing on the raw surface. */
export const CAPABILITY_PRICE_MAP: Record<string, { unit: "image" | "second"; usd: number }> = {
  "flux-schnell": { unit: "image", usd: 0.0032 },
  "flux-dev": { unit: "image", usd: 0.026 },
  "seedance-mini-i2v": { unit: "second", usd: 0.1625 },
  "pixverse-t2v": { unit: "second", usd: 0.1 }
};

export interface AuditEvent {
  id: string;
  at: string;
  kind: string; // "preflight.block" | "dkg.publish" | "generation.complete" ...
  summary: string;
  refs: string[];
}
