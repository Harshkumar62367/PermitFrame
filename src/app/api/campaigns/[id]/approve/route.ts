import { NextRequest, NextResponse } from "next/server";
import { approveCampaign } from "@/server/campaigns";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";

export const dynamic = "force-dynamic";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const result = await approveCampaign(id);
    if (!result.approved) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({
      approved: true,
      campaignUAL: result.ual,
      publicationStatus: result.publicationStatus ?? null,
      verificationRef: result.verificationRef ?? null,
      verificationWarning: result.verificationWarning ?? null
    });
  } catch (error) {
    logDkgError("approve", error);
    const safe = sanitizeDkgError(error, "approve");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
