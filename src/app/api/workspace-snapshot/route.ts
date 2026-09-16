import { NextResponse } from "next/server";
import { AuthenticationRequiredError } from "@/server/auth";
import { getWorkspaceSnapshot } from "@/server/workspace-snapshot";

export const dynamic = "force-dynamic";

/**
 * Authenticated workspace snapshot: overview summaries/totals, product
 * facts, source media, consent invites, passport summaries, expiry warnings
 * in one Neon-backed read. No DKG or Livepeer calls — those load
 * independently and must never block workspace views.
 */
export async function GET() {
  try {
    return NextResponse.json(await getWorkspaceSnapshot());
  } catch (error) {
    // Authorization behaves exactly like the sibling read routes (propagates
    // to the default error mapping); only genuine failures become a 503.
    if (error instanceof AuthenticationRequiredError) throw error;
    return NextResponse.json(
      { error: error instanceof Error ? error.message.slice(0, 300) : "Workspace snapshot failed." },
      { status: 503 }
    );
  }
}
