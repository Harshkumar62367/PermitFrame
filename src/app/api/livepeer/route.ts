import { NextResponse } from "next/server";
import { LivepeerMcpClient, livepeerConfig } from "@/server/livepeer/mcp-client";
import { catalogueSnapshot, roleCapabilities } from "@/server/livepeer/catalogue";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";

export const dynamic = "force-dynamic";

export async function GET() {
  const client = new LivepeerMcpClient(livepeerConfig());
  try {
    const [capabilities, pricing] = await Promise.all([
      client.listCapabilities(),
      client.getPricing().catch(() => ({}))
    ]);
    // Role mapping + auth mode are best-effort context for judges and
    // Settings; they never fail the capabilities payload itself.
    let roles: { image: string | null; motion: string | null } | null = null;
    let authMode: "bearer-key" | "keyless-hosted" = livepeerConfig().bearer ? "bearer-key" : "keyless-hosted";
    let checkedAt: string | null = null;
    try {
      const snapshot = await catalogueSnapshot();
      roles = roleCapabilities(snapshot);
      authMode = snapshot.authMode;
      checkedAt = snapshot.checkedAt;
    } catch {
      // capabilities payload below still stands on its own
    }
    return NextResponse.json({ ok: true, capabilities, pricing, roles, authMode, checkedAt });
  } catch (error) {
    // Provider internals (auth, endpoints, payloads) never reach Settings.
    logDkgError("livepeer-capabilities", error);
    const safe = sanitizeDkgError(error, "provider");
    return NextResponse.json({ ok: false, error: safe.message, code: safe.code }, { status: safe.status });
  }
}
