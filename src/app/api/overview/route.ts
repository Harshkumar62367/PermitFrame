import { NextResponse } from "next/server";
import { AuthenticationRequiredError } from "@/server/auth";
import { getWorkspaceOverview } from "@/server/overview";

export const dynamic = "force-dynamic";

/**
 * Cohesive workspace overview: campaigns (+creator names), expiry warnings,
 * spend and output rollups in one request. No DKG health or Livepeer checks —
 * those load independently via /api/health and must never block the dashboard.
 */
export async function GET() {
  try {
    return NextResponse.json(await getWorkspaceOverview());
  } catch (error) {
    // Authorization behaves exactly like the sibling read routes (propagates
    // to the default error mapping); only genuine failures become a 503.
    if (error instanceof AuthenticationRequiredError) throw error;
    return NextResponse.json(
      { error: error instanceof Error ? error.message.slice(0, 300) : "Workspace overview failed." },
      { status: 503 }
    );
  }
}
