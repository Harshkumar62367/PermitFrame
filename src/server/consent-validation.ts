import type { ConsentDraft, CountryCode, Platform, Transformation } from "./types";

const PLATFORMS: readonly Platform[] = ["instagram", "tiktok", "youtube", "linkedin"];
const TRANSFORMATIONS: readonly Transformation[] = ["edit", "animate", "crop", "upscale"];
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface AttestationInput {
  platforms?: unknown;
  countries?: unknown;
  allowedTransformations?: unknown;
  validUntil?: unknown;
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

  return { ok: true, value: { platforms, countries, allowedTransformations, validUntil: body.validUntil } };
}
