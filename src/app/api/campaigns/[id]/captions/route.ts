import { NextRequest, NextResponse } from "next/server";
import { generateCaptions } from "@/server/platform";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";

export const dynamic = "force-dynamic";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json({ captions: await generateCaptions(id) });
  } catch (e) {
    logDkgError("captions", e);
    const safe = sanitizeDkgError(e, "workspace");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
