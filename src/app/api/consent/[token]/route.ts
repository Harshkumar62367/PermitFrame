import { NextRequest, NextResponse } from "next/server";
import type { PermissionPassport } from "@/server/types";
import { loadInviteContext, newId, nowIso, updateWorkspaceDb } from "@/server/store";
import { getDkg } from "@/server/dkg";
import { passportKa } from "@/server/dkg/schemas";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await loadInviteContext(token);
  if (!ctx) return NextResponse.json({ error: "Consent link not found" }, { status: 404 });
  const invite = ctx.db.consentInvites.find((i) => i.token === token) ?? null;
  if (!invite) return NextResponse.json({ error: "Consent link not found" }, { status: 404 });
  const creator = ctx.db.creators.find((c) => c.id === invite.creatorId);
  return NextResponse.json({
    status: invite.status,
    draft: invite.draft,
    creator: creator ? { name: creator.name, handle: creator.handle } : null
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const body = (await request.json()) as {
    platforms?: string[];
    countries?: string[];
    allowedTransformations?: string[];
    validUntil?: string;
  };
  const ctx = await loadInviteContext(token);
  const invite = ctx?.db.consentInvites.find((i) => i.token === token) ?? null;
  if (!ctx || !invite) return NextResponse.json({ error: "Consent link not found" }, { status: 404 });
  if (invite.status === "completed") return NextResponse.json({ error: "Consent already attested" }, { status: 400 });

  const creatorName =
    ctx.db.creators.find((c) => c.id === invite.creatorId)?.name ?? "Creator";
  const passport: PermissionPassport = {
    id: newId("passport"),
    creatorId: invite.creatorId,
    creatorName,
    sourceMediaIds: invite.draft.sourceMediaIds,
    platforms: (body.platforms?.length ? body.platforms : invite.draft.platforms) as PermissionPassport["platforms"],
    countries: (body.countries?.length ? body.countries : invite.draft.countries).map((c) => c.toUpperCase()),
    allowedTransformations: (body.allowedTransformations?.length
      ? body.allowedTransformations
      : invite.draft.allowedTransformations) as PermissionPassport["allowedTransformations"],
    validFrom: nowIso().slice(0, 10),
    validUntil: body.validUntil ?? invite.draft.validUntil,
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

  await updateWorkspaceDb(ctx.workspaceId, (d) => {
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
}
