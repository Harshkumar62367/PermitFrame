import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { createCreator } from "@/server/platform";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";

export const dynamic = "force-dynamic";

/**
 * Minimal creator onboarding: the signed-in agency adds a workspace-local
 * creator record (name + optional handle) so approved media, consent
 * requests, and campaigns have an explicit owner. Workspace-scoped via the
 * session - the client never supplies a workspace id. Database-only: this
 * performs no identity check and creates no permission; only a
 * creator-attested consent link does that.
 */
export async function POST(request: NextRequest) {
  try {
    await requireCurrentSession();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    throw error;
  }
  const body = (await request.json().catch(() => ({}))) as {
    name?: unknown;
    handle?: unknown;
  };
  try {
    const creator = await createCreator({ name: body.name, handle: body.handle });
    return NextResponse.json({ creator });
  } catch (e) {
    logDkgError("creator-create", e);
    const safe = sanitizeDkgError(e, "workspace");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
