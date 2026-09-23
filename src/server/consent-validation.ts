import type { ConsentDraft, ConsentInviteStatus, CountryCode, Platform, Transformation } from "./types";

const PLATFORMS: readonly Platform[] = ["instagram", "tiktok", "youtube", "linkedin"];
const TRANSFORMATIONS: readonly Transformation[] = ["edit", "animate", "crop", "upscale"];
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Agency purpose text cap (request scope summary). */
export const CONSENT_PURPOSE_MAX = 140;
/** Fixed request-link lifetime in days (separate from permission expiry). */
export const CONSENT_LINK_LIFETIME_DAYS = 14;
/** Creator decline-note cap (local audit only, never published). */
export const DECLINE_NOTE_MAX = 500;

export interface AttestationInput {
  platforms?: unknown;
  countries?: unknown;
  allowedTransformations?: unknown;
  validUntil?: unknown;
}

/** Two explicit creator acknowledgements, required before approval. */
export function validateAttestationAcks(body: { acknowledgements?: unknown }): { ok: true } | { ok: false; error: string } {
  const a = body.acknowledgements;
  const confirmed = Array.isArray(a)
    ? a.length === 2 && a.every((x) => x === true)
    : typeof a === "object" &&
      a !== null &&
      (a as Record<string, unknown>).rights === true &&
      (a as Record<string, unknown>).use === true;
  if (!confirmed) return { ok: false, error: "Please confirm both acknowledgement statements to attest." };
  return { ok: true };
}

export interface ValidAttestation {
  platforms: Platform[];
  countries: CountryCode[];
  allowedTransformations: Transformation[];
  validUntil: string;
}

export type AttestationValidation =
  | { ok: true; value: ValidAttestation }
  | { ok: false; error: string };

/**
 * Server-side attestation rules. The creator may only *narrow* the agency's
 * offered draft - never widen it - and the expiry must be a future date.
 * Pure (no session, no I/O) so every branch is unit-testable; the route
 * enforces the verdict before any passport or DKG write.
 */
export function validateAttestation(
  body: AttestationInput,
  draft: ConsentDraft,
  today: string = new Date().toISOString().slice(0, 10)
): AttestationValidation {
  const fail = (error: string): AttestationValidation => ({ ok: false, error });

  if (!Array.isArray(body.platforms) || body.platforms.length === 0) {
    return fail("Choose at least one platform - otherwise the passport permits nothing.");
  }
  const platforms: Platform[] = [];
  for (const p of body.platforms) {
    const v = typeof p === "string" ? p.toLowerCase() : "";
    if (!(PLATFORMS as readonly string[]).includes(v)) return fail(`Unsupported platform: ${String(p).slice(0, 40)}.`);
    platforms.push(v as Platform);
  }
  const offeredPlatforms = new Set(draft.platforms.map((p) => p.toLowerCase()));
  const widenedPlatform = platforms.find((p) => !offeredPlatforms.has(p));
  if (widenedPlatform) return fail("Attestation can only narrow the offered platforms, not widen them.");

  if (!Array.isArray(body.countries) || body.countries.length === 0) {
    return fail("Choose at least one territory.");
  }
  const countries: CountryCode[] = [];
  for (const c of body.countries) {
    const v = typeof c === "string" ? c.toUpperCase() : "";
    if (!COUNTRY_PATTERN.test(v)) return fail(`Invalid territory code: ${String(c).slice(0, 40)}. Use 2-letter codes.`);
    countries.push(v);
  }
  const offeredCountries = new Set(draft.countries.map((c) => c.toUpperCase()));
  const widenedCountry = countries.find((c) => !offeredCountries.has(c));
  if (widenedCountry) return fail("Attestation can only narrow the offered territories, not widen them.");

  const rawTransforms = body.allowedTransformations ?? [];
  if (!Array.isArray(rawTransforms)) return fail("allowedTransformations must be an array.");
  const allowedTransformations: Transformation[] = [];
  for (const t of rawTransforms) {
    const v = typeof t === "string" ? t.toLowerCase() : "";
    if (!(TRANSFORMATIONS as readonly string[]).includes(v)) {
      return fail(`Unsupported transformation: ${String(t).slice(0, 40)}.`);
    }
    allowedTransformations.push(v as Transformation);
  }
  const offeredTransforms = new Set(draft.allowedTransformations.map((t) => t.toLowerCase()));
  const widenedTransform = allowedTransformations.find((t) => !offeredTransforms.has(t));
  if (widenedTransform) return fail("Attestation can only narrow the offered transformations, not widen them.");

  if (typeof body.validUntil !== "string" || !DATE_PATTERN.test(body.validUntil)) {
    return fail("validUntil must be a YYYY-MM-DD date.");
  }
  if (body.validUntil <= today) return fail("Expiry must be in the future.");
  // Expiry narrowing: the creator may keep or shorten the offered expiry,
  // never extend it. YYYY-MM-DD strings compare chronologically.
  if (body.validUntil > draft.validUntil) {
    return fail("Attestation can only shorten the offered expiry, not extend it.");
  }

  return { ok: true, value: { platforms, countries, allowedTransformations, validUntil: body.validUntil } };
}

/** Publication-status-aware completion wording (pure, unit-tested). */
export type ConsentPublicationState = "published" | "saved" | "unknown";

export interface ConsentCompletionCopy {
  state: ConsentPublicationState;
  /** Lead sentence under the "Permission attested" heading. */
  lead: string;
  /** Short status line: published ledger proof vs local-only save. */
  status: string;
}

/**
 * What the consent page may claim after attestation. A real UAL earns the
 * published wording; a known local-only passport gets the saved wording; an
 * unconfirmable older link gets conservative wording - never "live", never
 * "published", never an implied public anchor unless proven.
 */
export function consentCompletionCopy(state: ConsentPublicationState): ConsentCompletionCopy {
  if (state === "published") {
    return {
      state,
      lead: "Your Permission Passport is published to the proof ledger.",
      status: "Published — public proof is available for this permission record."
    };
  }
  if (state === "saved") {
    return {
      state,
      lead: "Your permission record was saved.",
      status: "Saved — public proof is not available yet."
    };
  }
  return {
    state,
    lead: "Your permission was recorded.",
    status: "Public proof status for this older link cannot be confirmed here."
  };
}

/**
 * Publication status for one exact consent link (pure, unit-tested).
 * "published" only when the invite's own linked passport carries a
 * non-empty UAL; "saved" when that exact passport exists without one;
 * "unknown" for legacy links without a passportId or a missing passport.
 * Never inferred from creatorId, name, date, or scope similarity.
 */
export function invitePublicationStatus(
  invite: { passportId?: string },
  passports: { id: string; ual?: string }[]
): ConsentPublicationState {
  if (!invite.passportId) return "unknown";
  const linked = passports.find((p) => p.id === invite.passportId);
  if (!linked) return "unknown";
  return typeof linked.ual === "string" && linked.ual.length > 0 ? "published" : "saved";
}

export interface ConsentPublicDraft {
  platforms: string[];
  countries: string[];
  allowedTransformations: string[];
  validUntil: string;
}

export interface ConsentPublicMedia {
  title: string;
  type: "image" | "video";
  url: string;
}

export interface ConsentPublicView {
  /** Derived lifecycle (legacy completed reads as approved). */
  status: ConsentLifecycle;
  draft: ConsentPublicDraft;
  /** Agency purpose; "" on legacy rows created before purpose existed. */
  purpose: string;
  /** Covered material (labels + preview URLs); empty on legacy rows. */
  media: ConsentPublicMedia[];
  /** Request-link expiry; absent on legacy rows (they never link-expire). */
  linkExpiresAt?: string;
  /** Approved links only: proof status of this exact link's passport. */
  publicationStatus?: ConsentPublicationState;
  creator: { name: string; handle: string } | null;
}

/**
 * Minimal public consent view (pure, unit-tested). Exposes the offered
 * terms, purpose, covered media previews, the creator's public name, and -
 * for approved links - the publication status only. Passport ids, UALs,
 * workspace identifiers, owner identity, other records, hashes, and
 * diagnostics never leave.
 */
export function buildConsentPublicView(
  invite: {
    status: ConsentInviteStatus;
    draft: ConsentPublicDraft;
    passportId?: string;
    purpose?: string;
    linkExpiresAt?: string;
  },
  media: ConsentPublicMedia[],
  passports: { id: string; ual?: string }[],
  creator: { name: string; handle: string } | null,
  today: string = new Date().toISOString().slice(0, 10)
): ConsentPublicView {
  const status = consentLifecycle(invite, today);
  return {
    status,
    draft: {
      platforms: invite.draft.platforms,
      countries: invite.draft.countries,
      allowedTransformations: invite.draft.allowedTransformations,
      validUntil: invite.draft.validUntil
    },
    purpose: invite.purpose ?? "",
    media,
    ...(invite.linkExpiresAt ? { linkExpiresAt: invite.linkExpiresAt } : {}),
    ...(status === "approved" ? { publicationStatus: invitePublicationStatus(invite, passports) } : {}),
    creator
  };
}

/** Derived creator-facing lifecycle (legacy completed reads as approved). */
export type ConsentLifecycle = "pending" | "viewed" | "approved" | "declined" | "expired" | "cancelled";

/**
 * Derive the lifecycle for display and guards. Stored "completed" is the
 * legacy approved value. Pending/viewed rows past linkExpiresAt read as
 * expired (derived on read - never a stored transition). Legacy rows
 * without linkExpiresAt never link-expire. Unknown values fall back to
 * pending, the least assumptive live state.
 */
export function consentLifecycle(
  invite: { status: ConsentInviteStatus; linkExpiresAt?: string },
  today: string = new Date().toISOString().slice(0, 10)
): ConsentLifecycle {
  switch (invite.status) {
    case "approved":
    case "completed":
      return "approved";
    case "declined":
      return "declined";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
    case "draft":
    case "pending":
    case "viewed":
    default: {
      if (invite.linkExpiresAt && invite.linkExpiresAt < today) return "expired";
      return invite.status === "viewed" ? "viewed" : "pending";
    }
  }
}

type LifecycleGuard = { ok: true } | { ok: false; error: string };

/** Whether this lifecycle state may attest (approve). */
export function attestGuard(lifecycle: ConsentLifecycle): LifecycleGuard {
  if (lifecycle === "approved") return { ok: false, error: "Consent already attested" };
  if (lifecycle === "declined") return { ok: false, error: "This request was declined - no attestation was recorded." };
  if (lifecycle === "cancelled") return { ok: false, error: "This request was cancelled - ask the agency for a fresh link." };
  if (lifecycle === "expired") return { ok: false, error: "This request link has expired - ask the agency for a fresh link." };
  return { ok: true };
}

/** Whether this lifecycle state may decline (creator, no passport, no DKG). */
export function declineGuard(lifecycle: ConsentLifecycle): LifecycleGuard {
  if (lifecycle === "approved") return { ok: false, error: "Consent already attested" };
  if (lifecycle === "declined") return { ok: false, error: "This request was already declined." };
  if (lifecycle === "cancelled") return { ok: false, error: "This request was cancelled." };
  if (lifecycle === "expired") return { ok: false, error: "This request link has expired - ask the agency for a fresh link." };
  return { ok: true };
}

/** Whether the owner may cancel this lifecycle state. */
export function cancelGuard(lifecycle: ConsentLifecycle): LifecycleGuard {
  if (lifecycle === "approved") {
    return { ok: false, error: "Approved requests cannot be cancelled - revoke the passport instead." };
  }
  if (lifecycle === "declined") {
    return { ok: false, error: "Declined requests are closed - create a fresh request instead." };
  }
  if (lifecycle === "cancelled") return { ok: false, error: "Request is already cancelled." };
  if (lifecycle === "expired") return { ok: false, error: "Request link has already expired." };
  return { ok: true };
}

export interface ConsentRequestInput {
  creatorId?: unknown;
  sourceMediaIds?: unknown;
  platforms?: unknown;
  countries?: unknown;
  allowedTransformations?: unknown;
  validUntil?: unknown;
  purpose?: unknown;
}

export interface ValidConsentRequest {
  creatorId: string;
  sourceMediaIds: string[];
  platforms: Platform[];
  countries: CountryCode[];
  allowedTransformations: Transformation[];
  validUntil: string;
  purpose: string;
}

/**
 * Server-side consent-request rules for the agency (pure, unit-tested).
 * Source assets must be non-empty and belong to exactly one existing
 * creator - the request reuses that creator, never mints a duplicate.
 * Requested scope is explicit (transforms may be empty = display-only);
 * purpose is capped text. The created scope is immutable downstream:
 * creators may only narrow it via validateAttestation.
 */
export function validateConsentRequest(
  body: ConsentRequestInput,
  lookup: { creators: { id: string }[]; sourceMedia: { id: string; creatorId: string }[] },
  today: string = new Date().toISOString().slice(0, 10)
): { ok: true; value: ValidConsentRequest } | { ok: false; error: string } {
  const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

  const creatorId = typeof body.creatorId === "string" ? body.creatorId.trim() : "";
  if (!creatorId) return fail("A creator is required - select approved media first.");
  if (!lookup.creators.some((c) => c.id === creatorId)) {
    return fail("Creator not found - the selected media has no known creator.");
  }
  if (!Array.isArray(body.sourceMediaIds) || body.sourceMediaIds.length === 0) {
    return fail("Select at least one approved media asset for this request.");
  }
  const sourceMediaIds = [...new Set(body.sourceMediaIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0))];
  if (sourceMediaIds.length === 0) return fail("Select at least one approved media asset for this request.");
  const found = sourceMediaIds.map((id) => lookup.sourceMedia.find((m) => m.id === id));
  if (found.some((m) => !m)) return fail("One or more selected media assets were not found.");
  const owners = new Set((found as { creatorId: string }[]).map((m) => m.creatorId));
  if (owners.size !== 1 || !owners.has(creatorId)) {
    return fail("All selected media must belong to exactly one creator.");
  }

  if (!Array.isArray(body.platforms) || body.platforms.length === 0) {
    return fail("Select at least one platform.");
  }
  const platforms: Platform[] = [];
  for (const p of body.platforms) {
    const v = typeof p === "string" ? p.toLowerCase() : "";
    if (!(PLATFORMS as readonly string[]).includes(v)) return fail(`Unsupported platform: ${String(p).slice(0, 40)}.`);
    platforms.push(v as Platform);
  }

  if (!Array.isArray(body.countries) || body.countries.length === 0) {
    return fail("Select at least one territory.");
  }
  const countries: CountryCode[] = [];
  for (const c of body.countries) {
    const v = typeof c === "string" ? c.toUpperCase() : "";
    if (!COUNTRY_PATTERN.test(v)) return fail(`Invalid territory code: ${String(c).slice(0, 40)}. Use 2-letter codes.`);
    countries.push(v);
  }

  const rawTransforms = body.allowedTransformations ?? [];
  if (!Array.isArray(rawTransforms)) return fail("allowedTransformations must be an array.");
  const allowedTransformations: Transformation[] = [];
  for (const t of rawTransforms) {
    const v = typeof t === "string" ? t.toLowerCase() : "";
    if (!(TRANSFORMATIONS as readonly string[]).includes(v)) {
      return fail(`Unsupported transformation: ${String(t).slice(0, 40)}.`);
    }
    allowedTransformations.push(v as Transformation);
  }

  if (typeof body.validUntil !== "string" || !DATE_PATTERN.test(body.validUntil)) {
    return fail("validUntil must be a YYYY-MM-DD date.");
  }
  if (body.validUntil <= today) return fail("Expiry must be in the future.");

  const purpose = typeof body.purpose === "string" ? body.purpose.trim() : "";
  if (!purpose) return fail("Describe the campaign or use purpose for this request.");
  if (purpose.length > CONSENT_PURPOSE_MAX) {
    return fail(`Purpose must be ${CONSENT_PURPOSE_MAX} characters or fewer.`);
  }

  return { ok: true, value: { creatorId, sourceMediaIds, platforms, countries, allowedTransformations, validUntil: body.validUntil, purpose } };
}
