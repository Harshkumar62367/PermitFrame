import "server-only";
import { isDkgUnavailable, redactSecrets } from "./edge-node-adapter";

/**
 * Central server-side disclosure boundary for proof-service failures.
 *
 * Raw DKG/SSH/SCP/shell/filesystem/RPC/provider errors carry operational
 * detail (usernames, hostnames/IPs, key paths, temp files, command lines,
 * query text, context graph ids, transport internals) that must never reach
 * user-facing UI. This module is the single place that decides what leaves
 * the server:
 *
 * - `sanitizeDkgError` — wholesale classification for API error responses.
 *   Anything carrying operational detail (or matching the unreachable
 *   signatures) is replaced with a stable code + safe message. Only clean
 *   validation/policy text passes through untouched.
 * - `maskOperationalDetail` — token-level masking for persisted diagnostics
 *   (job errors, health details) where readability matters but leaked tokens
 *   must still die.
 * - `scrubStoredText` — read-path guard for older stored records: returns a
 *   safe fallback when a stored string carries operational detail.
 * - `logDkgError` — server logs keep the raw failure (after secret
 *   redaction), never the client.
 *
 * Client-side string replacement is never the security boundary.
 */

export type DkgErrorContext =
  | "query"
  | "preflight"
  | "publish"
  | "approve"
  | "mutation"
  | "provider"
  | "workspace";

export interface SanitizedError {
  code: string;
  message: string;
  status: number;
  retryable: boolean;
}

export const LEDGER_UNAVAILABLE = {
  code: "ledger_unavailable",
  message: "Proof ledger is temporarily unavailable. Your workspace data is safe; try again shortly."
} as const;

export const PERMISSION_CHECK_UNAVAILABLE = {
  code: "permission_check_unavailable",
  message: "We couldn’t check the latest permissions right now. Your campaign has not changed; try again shortly."
} as const;

export const PROOF_RECORDING_UNAVAILABLE = {
  code: "proof_recording_unavailable",
  message: "Approval was saved, but proof recording is temporarily unavailable. Retry proof recording later."
} as const;

export const PROOF_SERVICE_ERROR = {
  code: "proof_service_error",
  message: "Something went wrong while contacting the proof service. Try again shortly."
} as const;

const PROVIDER_UNAVAILABLE = {
  code: "provider_unavailable",
  message: "The generation service is temporarily unavailable. Nothing was spent; try again shortly."
} as const;

const WORKSPACE_ERROR = {
  code: "workspace_error",
  message: "Something went wrong - your workspace data is safe. Try again shortly."
} as const;

/** Operational-detail signatures: usernames/hosts/paths/commands/query artefacts. */
const OPERATIONAL_PATTERNS: RegExp[] = [
  /\bssh\b/i,
  /\bscp\b/i,
  /\bStrictHostKeyChecking\b/,
  /\bBatchMode\b/,
  /\bConnectTimeout\b/,
  /\bcommand failed\b/i,
  // Windows drive paths (C:\… / C:/…) — the trailing negative lookahead
  // excludes URL schemes (https://…), which are not operational detail.
  /\b[A-Za-z]:[\\/](?!\/)/,
  /\.ssh\b/i,
  /\bid_ed25519\b/i,
  /\/tmp\//,
  /\/home\//,
  /\/Users\//,
  /AppData[\\/]/,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/,
  /\bport 22\b/i,
  /0x[a-fA-F0-9]{40}/,
  /\bdid:dkg:\S+/i,
  /permitframe-acceptance-\S+/i,
  /\.sparql\b/i,
  /\.ttl\b/i,
  /\bpf-(sq|ka|r)-[\w-]+/i,
  /\bquery\.sparql\b/i,
  /--[\w-]+\s+\S/,
  /\b[\w.-]+@(?:(?:\d{1,3}\.){3}\d{1,3}|[\w.-]+:\d+)\b/,
  /\bENOENT\b|\bEACCES\b|\bECONNREFUSED\b|\bETIMEDOUT\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bcurl\b|\bwget\b/i,
  /\(\s*[\w.-]+:\d+:\d+\s*\)/
];

/** True when text carries operational detail that must never reach the UI. */
export function containsOperationalDetail(text: string): boolean {
  if (!text) return false;
  return (
    OPERATIONAL_PATTERNS.some((pattern) => pattern.test(text)) ||
    /\bdkg CLI failed\b/i.test(text) ||
    /\bEdge Node unreachable\b/i.test(text)
  );
}

/**
 * Token-level masking for persisted/readable diagnostics. Leaked tokens
 * become neutral placeholders; ordinary prose (model names, provider
 * statuses, validation text) passes through byte-identical.
 */
export function maskOperationalDetail(text: string): string {
  return text
    .replace(/\b[\w.-]+@(?:(?:\d{1,3}\.){3}\d{1,3}|[\w.-]+:\d+)\b/g, "[identity]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[host]")
    .replace(/\b[A-Za-z]:[\\/](?!\/)[^\s"']*/g, "[path]")
    .replace(/\/(?:tmp|home|Users)\/[^\s"']*/g, "[path]")
    .replace(/0x[a-fA-F0-9]{40}/g, "0x[address]")
    .replace(/\bdid:dkg:\S+/gi, "[proof-ref]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]");
}

function contextMessage(context: DkgErrorContext): { code: string; message: string } {
  switch (context) {
    case "preflight":
      return PERMISSION_CHECK_UNAVAILABLE;
    case "publish":
    case "approve":
      return PROOF_RECORDING_UNAVAILABLE;
    case "provider":
      return PROVIDER_UNAVAILABLE;
    case "workspace":
      return WORKSPACE_ERROR;
    case "query":
    case "mutation":
    default:
      return LEDGER_UNAVAILABLE;
  }
}

/**
 * Deliberate user-safe domain messages, verified against the server
 * inventory (platform.ts, campaigns.ts, public-share.ts, route validation).
 * Anything not on this list is never shown, no matter how short or clean
 * it looks — deny by default for all proof-service contexts.
 */
const SAFE_EXACT_MESSAGES: ReadonlySet<string> = new Set([
  // missing records / deliberate domain outcomes
  "Campaign not found",
  "Passport not found",
  "Consent link not found",
  "Consent already attested",
  "Share link not found",
  "No creator in workspace",
  "Only the workspace owner may delete or archive campaigns.",
  // invite / attestation validation
  "Creator name is required.",
  "Select at least one platform.",
  "Add at least one 2-letter country code.",
  "Expiry must be a future date.",
  // creator onboarding (workspace-local record, no identity proof)
  "Give the creator a name so media and requests can attach to them.",
  "Creator name must be 80 characters or fewer.",
  "Handle may only contain letters, numbers, and @ _ . - (40 characters or fewer).",
  "Choose a creator for this asset - add one in the Media library first.",
  "The chosen creator no longer exists - pick another one.",
  // private source-media uploads (server-validated, restricted delivery)
  "Choose a file to upload.",
  "Could not read the uploaded file - try again.",
  "The selected file is empty - choose a file with content.",
  "Unsupported file type - upload a JPEG, PNG, GIF, or WebP image, or an MP4, WebM, or MOV video.",
  "File content does not match its declared type - re-export the file and try again.",
  "Image is too large - images up to 10 MB can be uploaded.",
  "Video is too large - videos up to 25 MB can be uploaded.",
  "Upload is too large - images up to 10 MB and videos up to 25 MB can be uploaded.",
  "Upload storage is not configured - ask the workspace owner to connect durable storage first.",
  // captions / share / verification gates
  "Captions are only generated for policy-approved campaigns",
  "Share links need a ready-to-share output - previews and unsaved outputs stay private until durable storage confirms them.",
  "This campaign is archived - reviews are closed, but the record stays readable.",
  "Public verification snapshots require an approved campaign pack.",
  // approval / production gates
  "Blocked campaigns cannot be approved",
  "Only the workspace owner may approve campaigns.",
  "Produce the campaign pack before approving - previews and unsaved outputs cannot be signed off yet",
  "Store outputs securely before approving - provider-hosted legacy assets cannot be published as proof yet",
  "Resolve the rights block before choosing a production template - blocked campaigns never reach generation.",
  "Preflight has not approved this campaign",
  "No matching plan stages selected",
  "Only deliverable shared outputs can be approved - private, blocked, or not-yet-stored outputs cannot be signed off.",
  // production authorization revalidation (exact selected permission/media/facts)
  "The selected source media is no longer in this workspace - choose approved media again before producing.",
  "The selected source media does not belong to the campaign creator - choose approved media again before producing.",
  "Verified product facts for this campaign are missing - re-check the product record before producing.",
  "The selected product facts do not match this campaign's brand and product - re-check the product record before producing.",
  "Permission expiry can only be extended with a new creator consent - send a fresh consent request instead of renewing.",
  // renewal consent requests (prefilled, creator must still approve)
  "Renewal must extend into the future - pick a date after today.",
  "This permission names no approved media - create a new consent request manually.",
  // brief validation
  "Unknown platform.",
  "Use a 2-letter country code (e.g. GR for Greece, DE for Germany).",
  "Give the brief a little more to work with (12+ characters).",
  "Selected source media was not found.",
  "Platform, country, format and source are locked once production has started - clone a platform variant instead.",
  // route-level validation
  "platforms array is required",
  "validUntil must be YYYY-MM-DD",
  "requestedClaims must be an array of strings.",
  "text is required",
  "decision must be approved or changes_requested.",
  "comment must be under 2000 characters.",
  "Invalid JSON body.",
  "query is required",
  "stageId and instructions are required"
]);

/**
 * Interpolated-but-safe shapes: policy blockers and the archived gate,
 * which echoes the workspace's own title. Length-bounded and always
 * vetoed by the operational-detail gate above all else.
 */
const SAFE_PREFIXES: readonly string[] = [
  "Blocked ",
  "Blocked:",
  "Archived campaigns are read-only"
];

const MAX_PREFIX_MATCH_LENGTH = 400;

/**
 * Explicit allowlist for user-safe domain errors. Pure and testable.
 * `context` declares caller intent (kept for contract clarity and future
 * scoping); the allowlist itself is context-independent because a safe
 * domain sentence is safe in every UI. Never approves raw Error.message
 * based on length or lack of known-bad patterns — unknown text fails
 * closed and the caller falls back to the context-safe message.
 */
export function isSafePublicDomainError(message: string, context: DkgErrorContext): boolean {
  void context;
  if (!message) return false;
  const text = message.trim();
  if (containsOperationalDetail(text)) return false;
  if (SAFE_EXACT_MESSAGES.has(text)) return true;
  if (text.length > MAX_PREFIX_MATCH_LENGTH) return false;
  return SAFE_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** Runtime/engine failure shapes and opaque blobs: never user-facing. */
const ENGINE_PATTERNS: RegExp[] = [
  /cannot read propert/i,
  /is not a function/i,
  /unexpected token/i,
  /\bundefined is not\b/i,
  /\bnot defined\b/i,
  /maximum call stack/i,
  /\bTypeError\b|\bReferenceError\b|\bSyntaxError\b|\bRangeError\b/,
  /^\s*[{[]/
];

/**
 * Classify a caught failure for an API error response. Operational detail
 * and unreachable signatures always map to the context's safe message.
 * Only allowlisted domain text passes through — everything unmatched
 * (engine failures, blobs, unfamiliar transport/provider text) becomes
 * the context-safe or unknown-failure message. The raw message is never
 * returned for unmatched errors; callers log it via logDkgError.
 */
export function sanitizeDkgError(raw: unknown, context: DkgErrorContext): SanitizedError {
  const message = raw instanceof Error ? raw.message : String(raw ?? "");
  if (!message.trim()) return { ...PROOF_SERVICE_ERROR, status: 500, retryable: false };
  if (containsOperationalDetail(message) || isDkgUnavailable(message)) {
    return { ...contextMessage(context), status: 503, retryable: true };
  }
  if (/timed out|timeout|fetch failed|socket hang up|network|econn|enotfound|eai_again/i.test(message)) {
    return { ...contextMessage(context), status: 503, retryable: true };
  }
  if (/^https?:\/\/\S+\s+failed|provider .*failed|MCP .*failed/i.test(message)) {
    return { ...PROVIDER_UNAVAILABLE, status: 502, retryable: true };
  }
  if (
    message.trim().length > 400 ||
    ENGINE_PATTERNS.some((pattern) => pattern.test(message)) ||
    !isSafePublicDomainError(message, context)
  ) {
    return { ...PROOF_SERVICE_ERROR, status: 500, retryable: false };
  }
  // Allowlisted domain text (validation, policy blockers, missing records):
  // precise and safe to show.
  return { code: "request_failed", message: message.trim(), status: 400, retryable: false };
}

/**
 * Read-path guard for stored records (timeline summaries, job errors, run
 * notes): older rows may predate server-side sanitization. Clean text
 * passes through; tainted text becomes the fallback.
 */
export function scrubStoredText(text: string, fallback: string): string {
  if (!text) return text;
  return containsOperationalDetail(text) ? fallback : text;
}

/** Server logs keep the raw failure (secret-redacted). Never send this to a client. */
export function logDkgError(scope: string, raw: unknown): void {
  const message = raw instanceof Error ? raw.message : String(raw ?? "");
  console.error(`[${scope}]`, redactSecrets(message).slice(0, 500));
}
