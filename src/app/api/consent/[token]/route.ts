import { NextRequest, NextResponse } from "next/server";
import type { PermissionPassport } from "@/server/types";
import { loadInviteContext, newId, nowIso, updateWorkspaceDb } from "@/server/store";
import {
  attestGuard,
  buildConsentPublicView,
  consentLifecycle,
  validateAttestation,
  validateAttestationAcks
} from "@/server/consent-validation";
import { markConsentViewed, withConsentTransitionLock } from "@/server/platform";
import { withIdempotencyLock } from "@/server/idempotency";
import { getDkg } from "@/server/dkg";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";
import { passportKa } from "@/server/dkg/schemas";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await loadInviteContext(token);
  if (!ctx) return NextResponse.json({ error: "Consent link not found" }, { status: 404 });
  const invite = ctx.db.consentInvites.find((i) => i.token === token) ?? null;
  if (!invite) return NextResponse.json({ error: "Consent link not found" }, { status: 404 });
  // First open marks the request viewed: idempotent, publishes nothing.
  // Read reliability: a viewed-write failure never fails the GET, but the
  // normal path genuinely persists through the token's own workspace.
  if (invite.status === "pending") await markConsentViewed(token, ctx.workspaceId).catch(() => undefined);
  const fresh = (await loadInviteContext(token))?.db.consentInvites.find((i) => i.token === token) ?? invite;
  // Deliberately narrow: the offered terms, purpose, covered media previews,
  // and the creator's public name - plus, for approved links, the proof
  // status of this exact link's passport. No workspace ids, owner identity,
  // other creator records, raw media internals (hashes, UALs), passport ids,
  // UALs, or secrets ever leave this endpoint.
  const creator = ctx.db.creators.find((c) => c.id === invite.creatorId);
  const mediaById = new Map(ctx.db.sourceMedia.map((m) => [m.id, m]));
  const media = (invite.draft.sourceMediaIds ?? [])
    .map((id) => mediaById.get(id))
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
    .map((m) => ({ title: m.title, type: m.type, url: m.url }));
  return NextResponse.json(
    buildConsentPublicView(
      fresh,
      media,
      ctx.db.passports,
      creator ? { name: creator.name, handle: creator.handle } : null
    )
  );
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    platforms?: unknown;
    countries?: unknown;
    allowedTransformations?: unknown;
    validUntil?: unknown;
    acknowledgements?: unknown;
  };
  const ctx = await loadInviteContext(token);
  const invite = ctx?.db.consentInvites.find((i) => i.token === token) ?? null;
  if (!ctx || !invite) return NextResponse.json({ error: "Consent link not found" }, { status: 404 });
  const gate = attestGuard(consentLifecycle(invite));
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: 400 });
  const acks = validateAttestationAcks(body);
  if (!acks.ok) return NextResponse.json({ error: acks.error }, { status: 400 });
  const validated = validateAttestation(body, invite.draft);
  if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });

  // One-time attestation, race-safe: concurrent double-submits serialize on
  // the token lock and the second sees an already-decided link instead of
  // minting a second passport. Validation above runs lock-free (no writes).
  // The transition lock serializes against a racing decline: whichever
  // decision runs first wins, and the loser re-checks inside the lock and
  // returns its own honest outcome (no shared payload, no second passport,
  // no decline event on an approval win).
  try {
    return await withIdempotencyLock(`consent:${token}`, async () => {
    const fresh = await loadInviteContext(token);
    const live = fresh?.db.consentInvites.find((i) => i.token === token) ?? null;
    if (!fresh || !live) return NextResponse.json({ error: "Consent link not found" }, { status: 404 });
    const innerGate = attestGuard(consentLifecycle(live));
    if (!innerGate.ok) return NextResponse.json({ error: innerGate.error }, { status: 400 });
    return withConsentTransitionLock(token, async () => {
    const guarded = await loadInviteContext(token);
    const current = guarded?.db.consentInvites.find((i) => i.token === token) ?? null;
    if (!guarded || !current) return NextResponse.json({ error: "Consent link not found" }, { status: 404 });
    const transitionGate = attestGuard(consentLifecycle(current));
    if (!transitionGate.ok) return NextResponse.json({ error: transitionGate.error }, { status: 400 });

    const creatorName =
      guarded.db.creators.find((c) => c.id === current.creatorId)?.name ?? "Creator";
    const attested = validated.value;
  const passport: PermissionPassport = {
    id: newId("passport"),
    creatorId: current.creatorId,
    creatorName,
    sourceMediaIds: current.draft.sourceMediaIds,
    platforms: attested.platforms,
    countries: attested.countries,
    allowedTransformations: attested.allowedTransformations,
    validFrom: nowIso().slice(0, 10),
    validUntil: attested.validUntil,
    status: "active",
    attestation: {
      method: "creator-consent-link",
      consentedAt: nowIso(),
      declaration:
        "I attest that I own or control the listed content and grant the permissions selected above through PermitFrame. This attestation records my declaration and its integrity; it is not a legal ownership certificate."
    },
    visibility: "public"
  };

  let ual: string | undefined;
  let explorerUrl: string | undefined;
  try {
    const record = await getDkg().publish(passportKa(passport), passport.visibility);
    ual = record.ual;
    explorerUrl = record.explorerUrl;
  } catch {
    // publication failure shouldn't lose the attestation; passport is stored locally
  }

  await updateWorkspaceDb(guarded.workspaceId, (d) => {
    d.passports.push({ ...passport, ual });
    const invite2 = d.consentInvites.find((i) => i.token === token);
    if (invite2) {
      invite2.status = "approved";
      // Exact link: later reads resolve publication status from this
      // passport only, never from sibling passports of the same creator.
      invite2.passportId = passport.id;
      invite2.decision = { outcome: "approved", at: nowIso() };
    }
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "consent.attested",
      summary: `Creator ${passport.creatorName} attested a Permission Passport.`,
      refs: [passport.id]
    });
  });

  return NextResponse.json({ attested: true, passportId: passport.id, ual, explorerUrl });
    });
    });
  } catch (error) {
    logDkgError("consent-attest", error);
    const safe = sanitizeDkgError(error, "mutation");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
