import { NextRequest, NextResponse } from "next/server";
import { loadDb } from "@/server/store";
import { createConsentInvite } from "@/server/platform";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";
import type { Platform } from "@/server/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = await loadDb();
  return NextResponse.json({
    invites: db.consentInvites,
    passports: db.passports.map((p) => ({ id: p.id, creatorId: p.creatorId, creatorName: p.creatorName, status: p.status, validUntil: p.validUntil, ual: p.ual ?? null }))
  });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    creatorName?: unknown;
    handle?: unknown;
    platforms?: unknown;
    countries?: unknown;
    validUntil?: unknown;
  };
  try {
    const result = await createConsentInvite({
      creatorName: typeof body.creatorName === "string" ? body.creatorName : "",
      handle: typeof body.handle === "string" ? body.handle : undefined,
      platforms: Array.isArray(body.platforms) ? (body.platforms.filter((p): p is Platform => typeof p === "string") as Platform[]) : [],
      countries:
        typeof body.countries === "string"
          ? body.countries.split(",")
          : Array.isArray(body.countries)
            ? body.countries.filter((c): c is string => typeof c === "string")
            : [],
      validUntil: typeof body.validUntil === "string" ? body.validUntil : ""
    });
    return NextResponse.json({ token: result.token, url: `/consent/${result.token}` });
  } catch (e) {
    logDkgError("consent-invite", e);
    const safe = sanitizeDkgError(e, "workspace");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
