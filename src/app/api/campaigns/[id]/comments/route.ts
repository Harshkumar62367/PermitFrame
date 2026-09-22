import { NextRequest, NextResponse } from "next/server";
import { addComment } from "@/server/platform";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();
  if (!body.text?.trim()) return NextResponse.json({ error: "text is required" }, { status: 400 });
  try {
    return NextResponse.json({ campaign: await addComment(id, body.author?.trim() || "manager", body.text) });
  } catch (e) {
    logDkgError("comment", e);
    const safe = sanitizeDkgError(e, "workspace");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
