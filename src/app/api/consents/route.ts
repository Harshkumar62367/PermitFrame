import { NextRequest, NextResponse } from "next/server";
import { loadDb } from "@/server/store";
import { createConsentRequest } from "@/server/platform";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";
import type { Platform, Transformation } from "@/server/types";
import { IDEMPOTENCY_KEY_PATTERN } from "@/server/idempotency";

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
    creatorId?: unknown;
    sourceMediaIds?: unknown;
    platforms?: unknown;
    countries?: unknown;
    allowedTransformations?: unknown;
    validUntil?: unknown;
    purpose?: unknown;
    replacesToken?: unknown;
    idempotencyKey?: unknown;
  };
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (body.idempotencyKey !== undefined && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return NextResponse.json({ error: "Request retry key is invalid - refresh the form and try again." }, { status: 400 });
  }
  try {
    const result = await createConsentRequest({
      creatorId: typeof body.creatorId === "string" ? body.creatorId : "",
      sourceMediaIds: Array.isArray(body.sourceMediaIds) ? body.sourceMediaIds.filter((m): m is string => typeof m === "string") : [],
      platforms: Array.isArray(body.platforms) ? (body.platforms.filter((p): p is Platform => typeof p === "string") as Platform[]) : [],
      countries:
        typeof body.countries === "string"
          ? body.countries.split(",")
          : Array.isArray(body.countries)
            ? body.countries.filter((c): c is string => typeof c === "string")
            : [],
      allowedTransformations: Array.isArray(body.allowedTransformations)
        ? (body.allowedTransformations.filter((t): t is Transformation => typeof t === "string") as Transformation[])
        : [],
      validUntil: typeof body.validUntil === "string" ? body.validUntil : "",
      purpose: typeof body.purpose === "string" ? body.purpose : "",
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(typeof body.replacesToken === "string" && body.replacesToken ? { replacesToken: body.replacesToken } : {})
    });
    return NextResponse.json({ token: result.token, url: `/consent/${result.token}` });
  } catch (e) {
    logDkgError("consent-invite", e);
    const safe = sanitizeDkgError(e, "workspace");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
