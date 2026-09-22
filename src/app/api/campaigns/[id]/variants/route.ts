import { NextRequest, NextResponse } from "next/server";
import { cloneForPlatforms } from "@/server/platform";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";
import type { Platform } from "@/server/types";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();
  const platforms: Platform[] = body.platforms ?? [];
  if (!Array.isArray(platforms) || platforms.length === 0) {
    return NextResponse.json({ error: "platforms array is required" }, { status: 400 });
  }
  try {
    const campaigns = await cloneForPlatforms(id, platforms);
    return NextResponse.json({ campaigns });
  } catch (e) {
    // Variant creation runs permission checks against the ledger: raw
    // transport failures must never reach the UI (see public-errors).
    logDkgError("variants", e);
    const safe = sanitizeDkgError(e, "preflight");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
