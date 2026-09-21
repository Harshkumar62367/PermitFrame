// PermitFrame domain model.
// Knowledge Asset payloads are built from these types in server/dkg/schemas.ts.

export type Platform = "instagram" | "tiktok" | "youtube" | "linkedin";
export type CountryCode = string; // ISO 3166-1 alpha-2, e.g. "GR"
export type Transformation = "edit" | "animate" | "upscale" | "crop";
export type Visibility = "private" | "shared" | "public";

/**
 * Explicit persisted publication state. Set ONLY from real adapter results:
 * "local" (workspace store), "shared" (DKG Shared Working Memory),
 * "anchored" (on-chain Verifiable Memory finalize succeeded),
 * "failed" (a publish was attempted and failed — retryable).
 * Never inferred from ID/URI shape. Missing (legacy rows) means non-public.
 */
export type PublicationStatus = "local" | "shared" | "anchored" | "failed";

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
  /** Fingerprint of the reference URL string (registry correlation only — not a byte hash of the media). */
  hash: string;
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
  // Studio editorial fields (optional so older records keep working):
  // objective, primary message and visual direction refine the brief.
  // They never change the rights evaluation — platform, country, claims
  // and transformation do, and edits to those re-run preflight.
  objective?: string;
  primaryMessage?: string;
  visualDirection?: string;
}

export type CampaignStatus = "draft" | "blocked" | "generating" | "review" | "approved" | "archived";

export type JobStatus = ProductionJob["status"];

/**
 * A job is active while queued, rendering, previewed, or awaiting durable
 * storage. `storage_retry_needed` is settled (explicit user retry only) and
 * `ready_to_share` / `failed` are terminal. Single helper so polling,
 * badges, metrics, and deletion guards agree.
 */
export function isActiveJobStatus(status: JobStatus): boolean {
  return status === "queued" || status === "generating" || status === "preview_ready" || status === "storage_pending";
}

/** Delivered: durable (or grandfathered legacy) and clear for share/proof. */
export function isDeliveredJobStatus(status: JobStatus): boolean {
  return status === "ready_to_share";
}

/**
 * One-time data migration for pre-lifecycle rows: `running` → `generating`,
 * `succeeded` → `ready_to_share` (legacy outputs were provider-hosted and
 * keep their powers, labeled honestly), `storage_pending` unchanged.
 * Throws on unknown values so the migrator reports instead of guessing.
 */
export function migrateJobStatus(status: string): JobStatus {
  if (status === "running") return "generating";
  if (status === "succeeded") return "ready_to_share";
  const valid: JobStatus[] = ["queued", "generating", "preview_ready", "storage_pending", "storage_retry_needed", "ready_to_share", "failed"];
  if ((valid as string[]).includes(status)) return status as JobStatus;
  throw new Error(`Unknown job status "${status}" — manual review required.`);
}

/**
 * Share/proof gate: only confirmed durable receipts. Legacy provider-hosted
 * outputs (no Cloudinary identity) stay previewable and readable, but locked
 * out of sharing, final delivery, and proof publication until stored.
 */
export function hasSharableReceipt(receipt: Pick<DerivativeReceipt, "storageStatus">): boolean {
  return receipt.storageStatus === "stored";
}

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
  /** Storage-safe request metadata: what was asked for, never secrets. */
  requestMeta?: {
    aspectRatio?: string;
    durationSeconds?: number;
    sourceKind?: "source-media" | "prior-output";
  };
  status: "queued" | "generating" | "preview_ready" | "storage_pending" | "storage_retry_needed" | "ready_to_share" | "failed";
  error?: string;
  outputUrl?: string;
  /** Provider output URL (Livepeer) — kept as provenance even after durable storage. */
  providerOutputUrl?: string;
  /**
   * Fingerprint of the provider URL string (correlation/debugging only).
   * NOT a content hash: no bytes are hashed, so it proves nothing about the
   * media itself. Never publish or display as content evidence.
   */
  providerUrlFingerprint?: string;
  /** @deprecated Retained for reading pre-fingerprint rows; same URL fingerprint as above. */
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
  /**
   * Fingerprint of the provider URL string (correlation/debugging only).
   * NOT a content hash: no bytes are hashed, so it proves nothing about the
   * media itself. Never publish or display as content evidence. Durable
   * proof references are the Cloudinary identity below plus job provenance.
   */
  providerUrlFingerprint?: string;
  /** @deprecated No longer written; retained for reading pre-fingerprint rows (same URL fingerprint). */
  outputHash?: string;
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
  /** Explicit state from the real publish result. Missing on legacy rows (non-public). */
  publicationStatus?: PublicationStatus;
  /**
   * Durable storage overlay (Cloudinary). Missing on legacy rows, which
   * render provider-hosted. `outputUrl` stays the canonical delivery URL
   * (durable once stored); provider provenance lives on the job record and
   * the asset row, never silently discarded.
   */
  storageProvider?: "cloudinary";
  storagePublicId?: string;
  storageUrl?: string;
  storageStatus?: "pending" | "stored" | "failed";
}

/**
 * Immutable-by-contract public verification snapshot. Built once per approval
 * from already-approved workspace data and containing ONLY intentional public
 * fields — no workspace/session ids, no user identifiers, no wallet material,
 * no private source media, no consent documents, no internal notes, no
 * private claims, no DKG payloads, no credentials. UAL/explorer are set only
 * when the record genuinely anchored.
 */
export interface PublicVerificationOutput {
  id: string;
  label: string;
  mediaType: "image" | "video";
  format: string;
  outputUrl: string;
  /**
   * Provider-URL fingerprint for correlation only — never content evidence.
   * Falls back to legacy rows' URL fingerprint of the same meaning.
   */
  providerUrlFingerprint?: string;
  capability: string;
  promptHash: string;
  claimsUsed: string[];
  generatedAt: string;
}

export interface PublicVerificationSnapshot {
  ref: string;
  campaignId: string;
  title: string;
  brand: string;
  productName: string;
  platform: string;
  country: string;
  status: "approved";
  approvedAt: string;
  creatorName: string;
  rightsSummary: {
    platforms: string[];
    countries: string[];
    validUntil: string;
    status: string;
  };
  verifiedClaims: string[];
  brandRules: {
    brand: string;
    productName: string;
    approvedClaims: string[];
  };
  captions: { platform: string; text: string; claimsUsed: string[]; disclosure: string }[];
  outputs: PublicVerificationOutput[];
  publicationStatus: PublicationStatus | null;
  /** Set ONLY when genuinely anchored. */
  ual: string | null;
  /** Set ONLY when genuinely anchored. */
  explorerUrl: string | null;
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
  /** Explicit state from the real VM publish result. Missing on legacy rows (non-public). */
  publicationStatus?: PublicationStatus;
  /** High-entropy public verification reference. Set at approval; anonymous reads use it. */
  verificationRef?: string;
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
  contextNote?: string;
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

/**
 * Durable record of one campaign-creation submission, keyed by a
 * client-generated idempotency key. A network failure after server-side
 * persistence must not create a second campaign when the same submission is
 * retried: the same workspace + key replays the original campaign id.
 * "processing" rows belong to a live holder or a crashed attempt (safe to
 * take over — nothing completed); only "completed" rows replay.
 */
export interface IdempotencyRecord {
  key: string;
  status: "processing" | "completed" | "failed";
  /** sha256 over the normalized creation payload the key was first used with. */
  fingerprint: string;
  campaignId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Database {
  creators: Creator[];
  passports: PermissionPassport[];
  sourceMedia: SourceMedia[];
  productFacts: ProductFacts[];
  campaigns: Campaign[];
  consentInvites: { token: string; creatorId: string; draft: ConsentDraft; status: "pending" | "completed" }[];
  events: AuditEvent[];
  /** Idempotency slots for campaign creation. Missing on legacy rows — treated as empty. */
  idempotencyKeys: Record<string, IdempotencyRecord>;
  /**
   * Deletion tombstones: id + title + time of hard-deleted campaigns. Makes
   * DELETE idempotent (retry returns success, never an error) and lets the
   * creation path answer honestly (410 Gone) instead of resurrecting a
   * deleted campaign under a replayed idempotency key. Missing on legacy
   * rows — treated as empty.
   */
  deletedCampaigns: DeletedCampaign[];
}

/** Minimal audit trace of a hard-deleted draft. The row itself is gone. */
export interface DeletedCampaign {
  id: string;
  title: string;
  deletedAt: string;
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
