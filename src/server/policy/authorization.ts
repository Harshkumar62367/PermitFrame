import type {
  Campaign,
  Database,
  PermissionPassport,
  ProductFacts,
  SourceMedia,
  Transformation
} from "../types";
import { getDkg } from "../dkg";
import type { DkgAdapter } from "../dkg/adapter";

/**
 * Centralized production authorization revalidation. Preflight decides
 * whether a campaign MAY be planned (first applicable passport wins); this
 * module proves the campaign's EXACT selected permission, media, facts,
 * transformations, territories, and expiry still authorize the planned use
 * at execution time - before a production run is created (submitRun) and
 * again before each job's first paid provider dispatch (dispatchSlot).
 *
 * Evidence tiers (fail closed throughout):
 * - live DKG reachable: the exact selected passport must be present in the
 *   creator's live passport list and fully valid. A different passport for
 *   the same creator never substitutes - absence fails, it never falls
 *   through to a sibling.
 * - live DKG unreachable: the workspace-stored passport row decides, but
 *   only if it exists and is fully valid (unexpired, unrevoked, matching).
 *   Anything ambiguous fails with an action-oriented message - never an
 *   invented match.
 * - media/facts binding always comes from the workspace database.
 *
 * Every rejection is a product-owned, action-oriented sentence carrying
 * only ids, enums, and dates - no DKG/provider diagnostics. Film runs use
 * their own submission path and are out of scope here.
 */

export type AuthorizationRevalidation =
  | { ok: true; passport: PermissionPassport }
  | { ok: false; error: string };

export interface AuthorizationEvidence {
  campaign: Pick<
    Campaign,
    "id" | "creatorId" | "sourceMediaId" | "passportId" | "productFactsId" | "brand" | "productName" | "request"
  >;
  /** Workspace row for campaign.sourceMediaId (undefined when removed). */
  media: SourceMedia | undefined;
  /** Workspace row for campaign.productFactsId (undefined when removed). */
  facts: ProductFacts | undefined;
  /**
   * Passport row for campaign.passportId: the live exact-id row when
   * discovery is reachable, otherwise the workspace-stored row (or
   * undefined when neither exists).
   */
  passport: PermissionPassport | undefined;
  /** Whether the passport row above came from live discovery. */
  liveReachable: boolean;
  /** YYYY-MM-DD under test; defaults to today. */
  today: string;
}

function fail(error: string): AuthorizationRevalidation {
  return { ok: false, error };
}

/**
 * Pure exact-binding decision over explicit evidence. No DKG, no database -
 * fully unit-testable. Legacy ambiguity (missing rows, blank dates) fails
 * safely with guidance, never with a guessed match.
 */
export function checkAuthorizationBinding(ev: AuthorizationEvidence): AuthorizationRevalidation {
  const { campaign, today } = ev;
  const req = campaign.request;

  // 1. Exact source-media binding: the row must exist and belong to the creator.
  if (!ev.media) {
    return fail(
      "The selected source media is no longer in this workspace - choose approved media again before producing."
    );
  }
  if (ev.media.creatorId !== campaign.creatorId) {
    return fail(
      "The selected source media does not belong to the campaign creator - choose approved media again before producing."
    );
  }

  // 2. Exact facts binding: required when claims are requested (mirrors
  // preflight); matched against the campaign whenever the row exists.
  if (req.requestedClaims.length > 0 && !ev.facts) {
    return fail(
      "Verified product facts for this campaign are missing - re-check the product record before producing."
    );
  }
  if (ev.facts) {
    const brandOk = ev.facts.brand.trim().toLowerCase() === campaign.brand.trim().toLowerCase();
    const productOk =
      ev.facts.productName.trim().toLowerCase() === campaign.productName.trim().toLowerCase();
    if (!brandOk || !productOk) {
      return fail(
        "The selected product facts do not match this campaign's brand and product - re-check the product record before producing."
      );
    }
    // Every requested claim must still be approved in the exact selected
    // facts: prohibited or absent claims block, mirroring preflight wording.
    for (const claim of req.requestedClaims) {
      const normalized = claim.toLowerCase();
      if (ev.facts.prohibitedClaims.some((c) => c.toLowerCase() === normalized)) {
        return fail(
          `"${claim}" is on the prohibited-claims list for ${campaign.productName}.`
        );
      }
      if (!ev.facts.approvedClaims.some((c) => c.toLowerCase() === normalized)) {
        return fail(
          `"${claim}" is not supported by any verified product fact for ${campaign.productName}.`
        );
      }
    }
  }

  // 3. Exact passport binding: the campaign-selected id, never a sibling.
  const passport = ev.passport;
  if (!passport) {
    return fail(
      ev.liveReachable
        ? `The selected permission passport (${campaign.passportId}) cannot be verified - it may be revoked, expired, or temporarily unreadable. Request a fresh consent to continue.`
        : `The selected permission passport (${campaign.passportId}) cannot be verified while the ledger is unreachable and no workspace record exists. Try again shortly or request a fresh consent.`
    );
  }
  // The permission must belong to the campaign creator AND name the exact
  // selected source media. A sibling passport covering the creator but not
  // this media never authorizes; missing/empty legacy media lists fail
  // closed instead of guessing.
  if (passport.creatorId !== campaign.creatorId) {
    return fail(
      `Permission passport ${passport.id} belongs to a different creator - request a fresh consent to continue.`
    );
  }
  const authorizedMedia = passport.sourceMediaIds ?? [];
  if (authorizedMedia.length === 0) {
    return fail(
      `Permission passport ${passport.id} names no approved media - request a fresh consent to continue.`
    );
  }
  if (!authorizedMedia.includes(campaign.sourceMediaId)) {
    return fail(
      `Permission passport ${passport.id} does not cover the selected source media - request a fresh consent to continue.`
    );
  }
  if (passport.status === "revoked") {
    return fail(
      `Permission passport ${passport.id} has been revoked - request a fresh consent to continue.`
    );
  }  if (passport.validUntil < today) {
    return fail(
      `Permission passport ${passport.id} expired on ${passport.validUntil} - request a fresh consent to continue.`
    );
  }
  if (passport.validFrom.trim() !== "" && passport.validFrom > today) {
    return fail(
      `Permission passport ${passport.id} is not valid until ${passport.validFrom} - production must wait.`
    );
  }
  const platformOk = passport.platforms.some(
    (p) => p.toLowerCase() === (req.platform as string).toLowerCase()
  );
  if (!platformOk) {
    return fail(
      `Permission passport ${passport.id} does not cover ${req.platform} - request a fresh consent to continue.`
    );
  }
  const countryOk = passport.countries.some(
    (c) => c.toLowerCase() === (req.country as string).toLowerCase()
  );
  if (!countryOk) {
    return fail(
      `Permission passport ${passport.id} does not cover ${req.country} - request a fresh consent to continue.`
    );
  }
  // Every derivative edits the source; video additionally animates it.
  const needed: Transformation[] = ["edit", ...(req.transformation === "video" ? ["animate" as Transformation] : [])];
  for (const kind of needed) {
    if (!passport.allowedTransformations.includes(kind)) {
      return fail(
        kind === "edit"
          ? `Permission passport ${passport.id} does not allow editing the creator's content.`
          : `Permission passport ${passport.id} does not allow animating the creator's content into video.`
      );
    }
  }
  return { ok: true, passport };
}

/** Bounded live lookup so a hung ledger cannot stall submission or dispatch. */
const LIVE_LOOKUP_TIMEOUT_MS = 30_000;

function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("ledger lookup timed out")), LIVE_LOOKUP_TIMEOUT_MS);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface RenewalAttestation {
  consentedAt: string;
  declaration: string;
}

/**
 * Pure gate for permission renewal: expiry may only be extended with a
 * fresh creator attestation (consentedAt + declaration from a new consent
 * flow). Missing or blank attestation refuses - the agency can never
 * extend consent by itself or append renewal text to the creator's
 * declaration. Callers persist the returned attestation verbatim.
 */
export function validateRenewalAttestation(
  input: unknown
): { ok: true; attestation: RenewalAttestation } | { ok: false; error: string } {
  const consentedAt =
    typeof (input as { consentedAt?: unknown } | null)?.consentedAt === "string"
      ? String((input as { consentedAt: string }).consentedAt).trim()
      : "";
  const declaration =
    typeof (input as { declaration?: unknown } | null)?.declaration === "string"
      ? String((input as { declaration: string }).declaration).trim()
      : "";
  if (consentedAt === "" || declaration === "") {
    return {
      ok: false,
      error:
        "Permission expiry can only be extended with a new creator consent - send a fresh consent request instead of renewing."
    };
  }
  return { ok: true, attestation: { consentedAt, declaration } };
}

/**
 * Revalidate one campaign's exact authorization against live + workspace
 * evidence. Prefer an injected adapter in tests; production resolves the
 * configured adapter. Never throws for proof-service states - every
 * failure mode (unavailable, expired, revoked, mismatched, unauthorized)
 * returns { ok: false } with an action-oriented message.
 */
export async function revalidateCampaignAuthorization(
  campaign: Campaign,
  db: Database,
  adapter?: DkgAdapter,
  today: string = todayIso()
): Promise<AuthorizationRevalidation> {
  const media = db.sourceMedia.find((m) => m.id === campaign.sourceMediaId);
  const facts = db.productFacts.find((f) => f.id === campaign.productFactsId);
  const workspacePassport = db.passports.find((p) => p.id === campaign.passportId);
  let live: PermissionPassport[] | null = null;
  try {
    const dkg = adapter ?? getDkg();
    live = await withTimeout(dkg.listPassports(campaign.creatorId));
  } catch {
    live = null;
  }
  if (live !== null) {
    return checkAuthorizationBinding({
      campaign,
      media,
      facts,
      passport: live.find((p) => p.id === campaign.passportId),
      liveReachable: true,
      today
    });
  }
  return checkAuthorizationBinding({
    campaign,
    media,
    facts,
    passport: workspacePassport,
    liveReachable: false,
    today
  });
}
