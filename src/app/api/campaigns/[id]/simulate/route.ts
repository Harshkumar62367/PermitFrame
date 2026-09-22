import { NextRequest, NextResponse } from "next/server";
import { loadCampaign } from "@/server/campaigns";
import { preflight } from "@/server/policy/engine";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";
import type { Campaign } from "@/server/types";

export const dynamic = "force-dynamic";

/**
 * Policy simulator: runs preflight against an overridden copy of the
 * campaign request. preflight() is a pure computation over the DKG - it
 * persists nothing - and this copy is never written back, so the stored
 * campaign and its real preflight decision stay untouched.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const original = await loadCampaign(id);
  if (!original) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    platform?: Campaign["request"]["platform"];
    country?: string;
    requestedClaims?: string[];
  };

  // Shallow copy with overrides applied - never persisted.
  const copy: Campaign = { ...original, request: { ...original.request } };
  copy.request.platform = body.platform ?? original.request.platform;
  copy.request.country = body.country ? body.country.toUpperCase() : original.request.country;
  copy.request.requestedClaims = body.requestedClaims ?? original.request.requestedClaims;

  try {
    const decision = await preflight(copy);
    return NextResponse.json({ decision });
  } catch (error) {
    logDkgError("simulate", error);
    const safe = sanitizeDkgError(error, "preflight");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
