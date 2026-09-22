import { NextResponse } from "next/server";
import { AuthenticationRequiredError } from "@/server/auth";
import { getWorkspaceOverview } from "@/server/overview";

export const dynamic = "force-dynamic";

/**
 * Cohesive workspace overview: campaigns (+creator names), expiry warnings,
 * spend and output rollups in one request. No DKG health or Livepeer checks -
 * those load independently via /api/health and must never block the dashboard.
 */
export async function GET() {
  try {
    return NextResponse.json(await getWorkspaceOverview());
  } catch (error) {
    // Same contract as the sibling read routes: expired/missing sessions are
    // 401 with guidance, never a 500.
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message.slice(0, 300) : "Workspace overview failed." },
      { status: 503 }
    );
  }
}
