import { NextRequest, NextResponse } from "next/server";
import { getDkg } from "@/server/dkg";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";

export const dynamic = "force-dynamic";

export async function GET() {
  const dkg = getDkg();
  try {
    const health = await dkg.health();
    const assets = await dkg.listAssets().catch(() => []);
    return NextResponse.json({ health, assets });
  } catch (error) {
    logDkgError("dkg-status", error);
    const safe = sanitizeDkgError(error, "query");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}

export async function POST(request: NextRequest) {
  let body: { query?: string };
  try {
    body = (await request.json()) as { query?: string };
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!body.query?.trim()) return NextResponse.json({ error: "query is required" }, { status: 400 });
  const dkg = getDkg();
  try {
    const bindings = await dkg.sparql(body.query);
    return NextResponse.json({ bindings, mode: dkg.mode });
  } catch (error) {
    // Read-only proof query: raw CLI/transport text must never reach the
    // inspector UI. Bounded timeout stays; only the wording is safe.
    logDkgError("dkg-query", error);
    const safe = sanitizeDkgError(error, "query");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
