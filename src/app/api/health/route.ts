import { NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { getIntegrationHealth } from "@/server/dkg/health-cache";

export const dynamic = "force-dynamic";

/**
 * Low-priority integration health, decoupled from workspace data.
 * Answers instantly from the server-side stale-while-revalidate cache and
 * never awaits the DKG CLI or the Livepeer probe on the request path — a
 * slow or stopped node cannot slow page mounts or flip healthy to offline.
 * No workspace reads, no seeding — the sidebar reads this independently
 * while views render from /api/overview and /api/workspace-snapshot.
 */
export async function GET() {
  try {
    await requireCurrentSession();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    throw error;
  }
  try {
    return NextResponse.json(await getIntegrationHealth());
  } catch (error) {
    // Unreachable by design (probes record states, never throw) — honest 503, never a hang.
    return NextResponse.json(
      { error: error instanceof Error ? error.message.slice(0, 300) : "Health check failed." },
      { status: 503 }
    );
  }
}
