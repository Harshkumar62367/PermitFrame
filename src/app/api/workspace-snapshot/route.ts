import { NextResponse } from "next/server";
import { AuthenticationRequiredError } from "@/server/auth";
import { getWorkspaceSnapshot } from "@/server/workspace-snapshot";

export const dynamic = "force-dynamic";

/**
 * Authenticated workspace snapshot: overview summaries/totals, product
 * facts, source media, consent invites, passport summaries, expiry warnings
 * in one Neon-backed read. No DKG or Livepeer calls - those load
 * independently and must never block workspace views.
 */
export async function GET() {
  try {
    return NextResponse.json(await getWorkspaceSnapshot());
  } catch (error) {
    // An expired/missing session is a 401 with guidance - never a 500 that
    // reads as a server failure and invites pointless retries.
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message.slice(0, 300) : "Workspace snapshot failed." },
      { status: 503 }
    );
  }
}
