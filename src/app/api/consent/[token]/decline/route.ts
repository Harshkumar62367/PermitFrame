import { NextRequest, NextResponse } from "next/server";
import { loadInviteContext } from "@/server/store";
import { consentLifecycle, declineGuard } from "@/server/consent-validation";
import { declineConsentRequest, withConsentTransitionLock } from "@/server/platform";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";

export const dynamic = "force-dynamic";

/**
 * Creator decline: records the decision locally with an optional note.
 * Creates no passport and never touches DKG - the note stays local audit
 * data, out of public proof. Serializes against a racing attestation on
 * the same transition lock: the loser re-checks inside the lock, so an
 * approval win returns "Consent already attested" with no decline event,
 * and a decline win refuses attestation with no passport or DKG call.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const body = (await request.json().catch(() => ({}))) as { note?: unknown };
  try {
    const ctx = await loadInviteContext(token);
    const invite = ctx?.db.consentInvites.find((i) => i.token === token) ?? null;
    if (!ctx || !invite) return NextResponse.json({ error: "Consent link not found" }, { status: 404 });
    const gate = declineGuard(consentLifecycle(invite));
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: 400 });
    return await withConsentTransitionLock(token, async () => {
      const guarded = await loadInviteContext(token);
      const current = guarded?.db.consentInvites.find((i) => i.token === token) ?? null;
      if (!guarded || !current) return NextResponse.json({ error: "Consent link not found" }, { status: 404 });
      const transitionGate = declineGuard(consentLifecycle(current));
      if (!transitionGate.ok) return NextResponse.json({ error: transitionGate.error }, { status: 400 });
      await declineConsentRequest(token, typeof body.note === "string" ? body.note : undefined, guarded.workspaceId);
      return NextResponse.json({ declined: true });
    });
  } catch (e) {
    logDkgError("consent-decline", e);
    const safe = sanitizeDkgError(e, "workspace");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
