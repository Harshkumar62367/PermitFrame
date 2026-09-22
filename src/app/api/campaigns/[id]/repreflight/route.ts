import { NextRequest, NextResponse } from "next/server";
import { rePreflight } from "@/server/campaigns";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";

export const dynamic = "force-dynamic";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const campaign = await rePreflight(id);
    if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    return NextResponse.json({ campaign });
  } catch (error) {
    logDkgError("repreflight", error);
    const safe = sanitizeDkgError(error, "preflight");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
