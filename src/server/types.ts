// PermitFrame domain model.
// Knowledge Asset payloads are built from these types in server/dkg/schemas.ts.

export type Platform = "instagram" | "tiktok" | "youtube" | "linkedin";
export type CountryCode = string; // ISO 3166-1 alpha-2, e.g. "GR"
export type Transformation = "edit" | "animate" | "upscale" | "crop";
export type Visibility = "private" | "shared" | "public";

/**
 * User-facing production quality profile. A product-level choice recorded on
 * the request and on every stage - never a persisted raw model assumption.
 * Missing on legacy rows means "balanced" (the default for final-quality work;
 * flux-schnell is reserved for explicit Draft previews).
 */
export type QualityProfile = "draft" | "balanced" | "premium";

/**
 * Production role a stage fulfills. Resolved per profile from live Creative
 * discovery - a model/tool is eligible only while discovery reports it
 * available. Tool-backed roles (critic) resolve to tool names, not models.
 */
export type StageRole =
  | "conceptImage"
  | "sourceGuidedImage"
  | "subjectPreservingImage"
  | "productPackshot"
  | "imageToVideo"
  | "upscale"
  | "tts"
  | "music"
  | "subtitle"
  | "critic";

/**
 * Where a stage must take its input pixels from. Independent stills derive
 * from the approved source (or the approved canonical anchor); only stages
 * that genuinely transform another output use stage-output with an explicit
 * dependency - never an accidental predecessor in run order.
 */
export type StageInputSource = "approved-source" | "canonical-anchor" | "stage-output";

/**
 * Explicit persisted publication state. Set ONLY from real adapter results:
 * "local" (workspace store), "shared" (DKG Shared Working Memory),
 * "anchored" (on-chain Verifiable Memory finalize succeeded),
 * "failed" (a publish was attempted and failed - retryable).
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
 * PermitFrame records the declaration and its integrity - it does not prove
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
  /** Fingerprint of the reference URL string (registry correlation only - not a byte hash of the media). */
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
  /**
   * Requested production quality profile (draft/balanced/premium). Optional
   * so older records keep working - missing means "balanced". Recorded on
   * every stage/job/receipt alongside the actual model used.
   */
  qualityProfile?: QualityProfile;
  /**
   * Template-driven production spec (pack, assets, formats, cap). Optional
   * JSON - legacy rows without one keep the default plan. No migration:
   * campaigns persist as JSONB documents.
   */
  productionSpec?: import("./livepeer/templates").TemplateSelection;
  /**
   * Campaign Film plan (first half: durable local planning + user
   * confirmation only). Optional JSON - legacy rows without one keep
   * current short-clip behavior exactly. No migration: campaigns persist
   * as JSONB documents. Saving a film plan never rebuilds preflight,
   * never submits a provider job, and never alters the template spec -
   * the runner, review, and proof paths do not read this field.
   */
  filmPlan?: import("./livepeer/film-plan").FilmPlan;
  // Studio editorial fields (optional so older records keep working):
  // objective, primary message and visual direction refine the brief.
  // They never change the rights evaluation - platform, country, claims
  // and transformation do, and edits to those re-run preflight.
  objective?: string;
  primaryMessage?: string;
  visualDirection?: string;
}

export type CampaignStatus = "draft" | "blocked" | "generating" | "review" | "approved" | "archived";

export type JobStatus = ProductionJob["status"];

/**
 * A job is active while queued, rendering, previewed, or awaiting durable
 * storage. `storage_retry_needed`, `cancelled`, `ready_to_share` and
 * `failed` are settled (explicit user retry only for the retry state).
 * Single helper so polling, badges, metrics, and deletion guards agree.
 */
export function isActiveJobStatus(status: JobStatus): boolean {
  return status === "queued" || status === "generating" || status === "preview_ready" || status === "storage_pending";
}

/** Settled without delivery (never shareable, never resumed). */
export function isSettledJobStatus(status: JobStatus): boolean {
  return status === "failed" || status === "cancelled" || status === "storage_retry_needed";
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
  const valid: JobStatus[] = ["queued", "generating", "preview_ready", "storage_pending", "storage_retry_needed", "ready_to_share", "failed", "cancelled"];
  if ((valid as string[]).includes(status)) return status as JobStatus;
  throw new Error(`Unknown job status "${status}" - manual review required.`);
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
  format: "9:16" | "4:5" | "1:1" | "16:9";
  /**
   * Explicit DAG edges: stage ids whose outputs must be ready before this
   * stage runs. Independent stills carry [] - they never inherit a sibling's
   * output through run order. Missing on legacy rows (treated as [] unless
   * the kind implies a keyframe dependency - see normalizeStagePlan).
   */
  dependsOnStageIds: string[];
  /**
   * Declared input pixels: approved-source (registered source media),
   * canonical-anchor (the approved canonical output, e.g. keyframe), or
   * stage-output (a declared dependency's output). Missing on legacy rows.
   */
  inputSource: StageInputSource;
  /** Requested quality profile for this stage (product choice, not a model). */
  qualityProfile: QualityProfile;
  /** Production role, resolved per profile from live discovery. */
  role: StageRole;
  /** Motion length in seconds for time-based stages (image-to-video). Resolved value. */
  durationSeconds?: number;
  /** Requested clip length before bucket/model adjustment (motion only). */
  requestedDurationSeconds?: number;
  /** Why resolved differs from requested (bucket adjustment), if it does. */
  durationNote?: string;
  /**
   * Where the applied duration limits came from: provider metadata,
   * a cited documented policy, or the unverified product range.
   */
  durationSource?: "provider-metadata" | "documented-model-policy" | "product-range-unverified";
  /**
   * "first-pick → actual" when live discovery substituted an unavailable
   * first preference at plan time. Copied onto jobs for honest provenance.
   */
  fallbackFrom?: string;
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
    /** Resolved clip length actually dispatched (motion only). */
    durationSeconds?: number;
    /** Requested clip length before adjustment (motion only). */
    requestedDurationSeconds?: number;
    /** Why resolved differs from requested, if it does. */
    durationNote?: string;
    /** Duration-limit provenance (motion only). */
    durationSource?: "provider-metadata" | "documented-model-policy" | "product-range-unverified";
    sourceKind?: "source-media" | "prior-output";
    /** Declared input source from the plan DAG. */
    inputSource?: StageInputSource;
    /** Input source actually used (differs when a dependency fell back honestly). */
    resolvedInputSource?: StageInputSource;
    /** Dependency stage whose output fed this run (stage-output inputs only). */
    sourceStageId?: string;
    /** Requested quality profile (product choice, not a model). */
    qualityProfile?: QualityProfile;
    /** Production role this job fulfills. */
    role?: StageRole;
    /** "a → b" when dispatch used a fallback for an unavailable first pick. */
    fallbackFrom?: string;
    /**
     * Approved-reference preservation provenance (structured - never parsed
     * from display text). Requested mode first, resolved mode after policy
     * validation, claimable evidence level, and the tools involved.
     * Missing on legacy rows (normalized to "no claim" at read time).
     */
    preservationRequested?: "source-guided-generation" | "subject-placement" | "product-photo" | "variation";
    preservationResolved?: "source-guided-generation" | "subject-placement" | "product-photo" | "variation";
    preservationEvidenceLevel?: "source-guided" | "subject-preserving" | "product-preserving" | "none";
    /** Tool the resolved mode intended ("deferred" = known-but-unwired). */
    preservationRequestedCapability?: string;
    /** Tool that actually rendered the output. */
    preservationActualCapability?: string;
    /** Approved source media id feeding this run (source-media inputs). */
    approvedSourceAssetId?: string;
    /** Why resolved differs from requested, or why an op fell back. */
    fallbackReason?: string;
    /**
     * Async preservation handle in flight: the provider job id belongs to
     * this preservation tool (not a create_media job). While set with a
     * livepeerJobId, the job is polled - never re-dispatched and never
     * given a create_media fallback. Cleared when the handle resolves.
     */
    preservationPendingTool?: "place_subject" | "create_variations";
    /**
     * Preservation tools that failed terminally for this job (async handle
     * died with no output). Dispatch never retries them - one guided
     * fallback, then done. Retrying a rejected tool under a fresh call
     * could double-spend; the same-key guided render dedupes instead.
     */
    preservationFailedTools?: string[];
    /** True once a provider output URL landed for the resolved operation.
     * "Operation succeeded" - never "identity verified" (no visual
     * similarity is measured). */
    providerOperationSucceeded?: boolean;
  };
  /**
   * Explicit user refinement: this job varies a selected completed output
   * (create_variations) rather than rendering from the plan. Set only by
   * the revise / variations actions - initial production never sets it, so
   * variations can never run automatically.
   */
  variationExplicit?: boolean;
  /** Requested quality profile, copied from the plan stage. */
  qualityProfile?: QualityProfile;
  /** Production role, copied from the plan stage. */
  role?: StageRole;
  /** Capability the plan asked for, before any auto-recovery substitution. */
  requestedCapability?: string;
  /**
   * Clean machine-readable capability actually dispatched (or last reported
   * by the provider). requestedCapability stays the initial ask; capability
   * stays the planned value. Never an arrow-formatted string - pricing,
   * dispatch, quotes, and receipts use this (falling back to capability).
   * Missing on legacy rows.
   */
  actualCapability?: string;
  /** Provider-reported model substitution note, if any (exact provenance). */
  modelNote?: string;
  /** Durable production run this job was dispatched under (async runner). */
  runId?: string;
  /** Dispatch attempts (submit calls). Retries reuse the same idempotency key. */
  attempts?: number;
  /** When the provider accepted the job (async submit returned a job id). */
  dispatchedAt?: string;
  /** Last submit attempt time (ISO). Drives backoff math. */
  lastAttemptAt?: string;
  /** Earliest next submit attempt (ISO). The pump will not redispatch before this. */
  nextAttemptAt?: string;
  /** Short redacted submit error awaiting retry (never secrets). */
  lastTransientError?: string;
  /**
   * Prior output URL this refinement varies (create_variations source).
   * Set by the revise flow; dispatch falls back to plain generation when
   * the variations call cannot serve it.
   */
  variationSourceUrl?: string;
  /** Vision quality score vs the approved source (0-1, advisory only). */
  qualityScore?: number;
  /** Whether the advisory quality check passed its threshold. */
  qualityPassed?: boolean;
  /** Advisory quality/critique note. Never fails a stage on its own. */
  qualityNote?: string;
  status: "queued" | "generating" | "preview_ready" | "storage_pending" | "storage_retry_needed" | "ready_to_share" | "failed" | "cancelled";
  error?: string;
  outputUrl?: string;
  /** Provider output URL (Livepeer) - kept as provenance even after durable storage. */
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
   * Measured pixel dimensions of the delivered file (from durable storage
   * metadata). Missing on legacy rows and provider-hosted outputs, which
   * carry no verified size — the UI then shows the requested format only,
   * never a guessed size.
   */
  actualWidth?: number;
  actualHeight?: number;
  /**
   * Requested-format vs measured-file aspect verdict (see livepeer/aspect).
   * "match" clears the output for its planned placement; "mismatch" marks
   * it needs-review (never Ready for the requested placement, approval
   * blocked until regenerated); "unknown" covers legacy and
   * provider-hosted rows with no measured size.
   */
  aspectVerdict?: "match" | "mismatch" | "unknown";
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
  /** Requested quality profile (product choice) - the model actually used is `capability`. */
  qualityProfile?: QualityProfile;
  /** Production role the output fulfills. Missing on legacy rows. */
  role?: StageRole;
  /** Capability the plan asked for, before any fallback/substitution. */
  requestedCapability?: string;
  /** Clean machine-readable capability actually rendered (never arrow text). */
  actualCapability?: string;
  /** Resolved motion clip length (video receipts only). */
  durationSeconds?: number;
  /** Requested clip length before adjustment (video receipts only). */
  requestedDurationSeconds?: number;
  /** Duration-limit provenance: provider metadata, cited policy, or unverified range. */
  durationSource?: "provider-metadata" | "documented-model-policy" | "product-range-unverified";
  /** Why resolved duration differs from requested, if it does. */
  durationNote?: string;
  derivedFrom: {
    sourceMediaId: string;
    passportId: string;
    productFactsId: string;
    /** Dependency stage whose output fed this run (stage-output inputs). */
    sourceStageId?: string;
  };
  /**
   * Preservation provenance copied from the rendering job (structured -
   * cards show what actually ran, not what was planned). Missing on legacy
   * rows, which normalize to "no claim" and keep rendering.
   */
  preservationRequested?: "source-guided-generation" | "subject-placement" | "product-photo" | "variation";
  preservationResolved?: "source-guided-generation" | "subject-placement" | "product-photo" | "variation";
  preservationEvidenceLevel?: "source-guided" | "subject-preserving" | "product-preserving" | "none";
  preservationRequestedCapability?: string;
  preservationActualCapability?: string;
  approvedSourceAssetId?: string;
  /** Why resolved differs from requested, or why an op fell back. */
  fallbackReason?: string;
  /** True once a provider output URL landed. "Operation succeeded" -
   * never "identity verified" (no visual similarity is measured). */
  providerOperationSucceeded?: boolean;
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
 * fields - no workspace/session ids, no user identifiers, no wallet material,
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
   * Provider-URL fingerprint for correlation only - never content evidence.
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

/**
 * Durable production run (async batch). Created synchronously at submit so
 * the browser request returns fast; the dependency-aware pump advances it
 * in the background and any later request (or restart) resumes it from
 * these records plus the job rows. Stored on the campaign document (JSONB)
 * - legacy rows without `runs` behave as run-less.
 */
export interface ProductionRun {
  id: string;
  campaignId: string;
  stageIds: string[];
  /**
   * Exact-job scope: when present (non-empty), every run operation -
   * dispatch selection, polling, reset, fail, cancel, completion,
   * progress, and ledger - addresses ONLY these job ids. Jobs sharing a
   * stageId are never touched merely for sharing it. Variation and
   * refinement runs always use this; template pack runs omit it and stay
   * stage/DAG scoped (legacy rows behave exactly as before).
   */
  jobIds?: string[];
  status: "active" | "complete" | "cancelled";
  /** Client-generated idempotency key: repeats return this run, never a duplicate. */
  idempotencyKey?: string;
  maxConcurrency: number;
  spendCapUsd?: number;
  estimateUsd?: number | null;
  note?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
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
  /** Durable async runs (newest last). Missing on legacy rows - treated as empty. */
  runs?: ProductionRun[];
  /**
   * Durable film execution runs (newest last). Optional JSON - legacy rows
   * without it have no film execution. The short-clip runner, review, and
   * proof paths never read this field, so film runs cannot distort them.
   */
  filmRuns?: import("./livepeer/film-run").FilmRun[];
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
 * take over - nothing completed); only "completed" rows replay.
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
  /** Idempotency slots for campaign creation. Missing on legacy rows - treated as empty. */
  idempotencyKeys: Record<string, IdempotencyRecord>;
  /**
   * Deletion tombstones: id + title + time of hard-deleted campaigns. Makes
   * DELETE idempotent (retry returns success, never an error) and lets the
   * creation path answer honestly (410 Gone) instead of resurrecting a
   * deleted campaign under a replayed idempotency key. Missing on legacy
   * rows - treated as empty.
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
  "flux-pro": { unit: "image", usd: 0.063 },
  "seedream-5-lite": { unit: "image", usd: 0.0368 },
  "nano-banana": { unit: "image", usd: 0.084 },
  "kontext-edit": { unit: "image", usd: 0.042 },
  "pixelcut-product-photo": { unit: "image", usd: 0.0252 },
  "topaz-upscale": { unit: "image", usd: 0.0053 },
  "ltx-25-i2v-fast": { unit: "second", usd: 0.0945 },
  "pixverse-i2v": { unit: "second", usd: 0.0683 },
  "kling-v3-turbo-i2v": { unit: "second", usd: 0.1176 },
  "kling-v3-turbo-pro-i2v": { unit: "second", usd: 0.147 },
  "seedance-i2v": { unit: "second", usd: 0.3176 },
  "seedance-mini-i2v": { unit: "second", usd: 0.1625 },
  "veo-i2v": { unit: "second", usd: 0.42 },
  "pixverse-t2v": { unit: "second", usd: 0.1 }
};

export interface AuditEvent {
  id: string;
  at: string;
  kind: string; // "preflight.block" | "dkg.publish" | "generation.complete" ...
  summary: string;
  refs: string[];
}
