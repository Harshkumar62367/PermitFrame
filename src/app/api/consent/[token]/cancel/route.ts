import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadDb } from "@/server/store";
import { cancelConsentRequest } from "@/server/platform";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";

export const dynamic = "force-dynamic";

/**
 * Owner cancellation of a live consent request. Session-gated (agency
 * only): pending/viewed rows become cancelled and stay for audit.
 * Approved and declined rows are terminal and refuse.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    await requireCurrentSession();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    throw error;
  }
  try {
    const db = await loadDb();
    if (!db.consentInvites.some((i) => i.token === token)) {
      return NextResponse.json({ error: "Consent request not found" }, { status: 404 });
    }
    await cancelConsentRequest(token);
    return NextResponse.json({ cancelled: true });
  } catch (e) {
    logDkgError("consent-cancel", e);
    const safe = sanitizeDkgError(e, "workspace");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
