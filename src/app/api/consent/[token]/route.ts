import { NextRequest, NextResponse } from "next/server";
import type { PermissionPassport } from "@/server/types";
import { loadInviteContext, newId, nowIso, updateWorkspaceDb } from "@/server/store";
import { validateAttestation } from "@/server/consent-validation";
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
  // Deliberately narrow: the offered terms plus the creator's public name.
  // No workspace ids, owner identity, other creators, source-media internals,
  // contacts, notes, or secrets ever leave this endpoint.
  const creator = ctx.db.creators.find((c) => c.id === invite.creatorId);
  return NextResponse.json({
    status: invite.status,
    draft: {
      platforms: invite.draft.platforms,
      countries: invite.draft.countries,
      allowedTransformations: invite.draft.allowedTransformations,
      validUntil: invite.draft.validUntil
    },
    creator: creator ? { name: creator.name, handle: creator.handle } : null
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    platforms?: unknown;
    countries?: unknown;
    allowedTransformations?: unknown;
    validUntil?: unknown;
  };
  const ctx = await loadInviteContext(token);
  const invite = ctx?.db.consentInvites.find((i) => i.token === token) ?? null;
  if (!ctx || !invite) return NextResponse.json({ error: "Consent link not found" }, { status: 404 });
  if (invite.status === "completed") return NextResponse.json({ error: "Consent already attested" }, { status: 400 });
  const validated = validateAttestation(body, invite.draft);
  if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });

  // One-time attestation, race-safe: concurrent double-submits serialize on
  // the token lock and the second sees "completed" instead of minting a
  // second passport. Validation above runs lock-free (no writes involved).
  try {
    return await withIdempotencyLock(`consent:${token}`, async () => {
    const fresh = await loadInviteContext(token);
    const live = fresh?.db.consentInvites.find((i) => i.token === token) ?? null;
    if (!fresh || !live) return NextResponse.json({ error: "Consent link not found" }, { status: 404 });
    if (live.status === "completed") return NextResponse.json({ error: "Consent already attested" }, { status: 400 });

    const creatorName =
      fresh.db.creators.find((c) => c.id === live.creatorId)?.name ?? "Creator";
    const attested = validated.value;
  const passport: PermissionPassport = {
    id: newId("passport"),
    creatorId: live.creatorId,
    creatorName,
    sourceMediaIds: live.draft.sourceMediaIds,
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

  await updateWorkspaceDb(fresh.workspaceId, (d) => {
    d.passports.push({ ...passport, ual });
    const invite2 = d.consentInvites.find((i) => i.token === token);
    if (invite2) invite2.status = "completed";
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
  } catch (error) {
    logDkgError("consent-attest", error);
    const safe = sanitizeDkgError(error, "mutation");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
