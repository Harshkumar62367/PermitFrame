import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError } from "@/server/auth";
import { revokePassport } from "@/server/platform";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  try {
    const result = await revokePassport(id, body.note ?? "");
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    logDkgError("revoke", e);
    const safe = sanitizeDkgError(e, "mutation");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
