import { NextRequest, NextResponse } from "next/server";
import { createShareLink } from "@/server/platform";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";

export const dynamic = "force-dynamic";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const token = await createShareLink(id);
    return NextResponse.json({ token, url: `/share/${token}` });
  } catch (e) {
    // Database-only write: recovery copy stays DKG-free by construction.
    logDkgError("share-create", e);
    const safe = sanitizeDkgError(e, "workspace");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
