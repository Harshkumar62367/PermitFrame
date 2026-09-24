import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadDb } from "@/server/store";
import { buildRenewalConsentInput, createConsentRequest } from "@/server/platform";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";

export const dynamic = "force-dynamic";

/**
 * Start a RENEWAL consent request for a passport. This never extends,
 * overwrites, or republishes the old permission: it builds a fresh consent
 * request prefilled from the old scope (same creator, media, platforms,
 * territories, transformations; agency-picked new expiry) and the creator
 * must approve it before anything renews. The old passport row - expired
 * or revoked - stays intact as history.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const validUntil = typeof body.validUntil === "string" ? body.validUntil : "";
  try {
    await requireCurrentSession();
    const db = await loadDb();
    const passport = db.passports.find((p) => p.id === id);
    if (!passport) return NextResponse.json({ error: "Passport not found" }, { status: 404 });
    const renewal = buildRenewalConsentInput(passport, validUntil);
    if (!renewal.ok) return NextResponse.json({ error: renewal.error }, { status: 400 });
    const result = await createConsentRequest(renewal.input);
    return NextResponse.json({ token: result.token, url: `/consent/${result.token}`, passportId: id });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    logDkgError("renew", error);
    const safe = sanitizeDkgError(error, "workspace");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
