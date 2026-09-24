import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError } from "@/server/auth";
import { loadDb } from "@/server/store";
import { registerSourceMedia, resolveMediaCreator } from "@/server/platform";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";

export const dynamic = "force-dynamic";

function authError() {
  return NextResponse.json({ error: "Authentication required" }, { status: 401 });
}

export async function GET() {
  try {
    return NextResponse.json({ media: (await loadDb()).sourceMedia });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return authError();
    throw error;
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  if (!body.url?.trim().startsWith("http")) return NextResponse.json({ error: "A public https URL is required" }, { status: 400 });
  let db;
  try {
    db = await loadDb();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return authError();
    throw error;
  }
  // Explicit creator only: the server never falls back to the first
  // workspace record, which would silently attach media to a creator the
  // user did not choose. The UI requires a creator selection.
  const resolved = resolveMediaCreator(db, body.creatorId);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }
  const creator = resolved.value;
  try {
    const media = await registerSourceMedia({
      creatorId: creator.id,
      title: body.title,
      url: body.url,
      type: body.type === "video" ? "video" : "image"
    });
    return NextResponse.json({ media });
  } catch (e) {
    logDkgError("media-register", e);
    const safe = sanitizeDkgError(e, "workspace");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
