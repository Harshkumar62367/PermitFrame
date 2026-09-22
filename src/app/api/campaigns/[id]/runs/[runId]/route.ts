import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadCampaign } from "@/server/campaigns";
import { getRunStatusSnapshot } from "@/server/livepeer/runner";

export const dynamic = "force-dynamic";

/**
 * Run status + spend ledger, strictly bounded for the 15s UI abort -
 * see getRunStatusSnapshot: read/poll-only short pump, detached full pump,
 * cached-prices-only ledger.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  let workspaceId: string;
  try {
    workspaceId = (await requireCurrentSession()).workspaceId;
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    throw error;
  }
  const campaign = await loadCampaign(id);
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  if (!campaign.runs?.some((r) => r.id === runId)) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const snapshot = await getRunStatusSnapshot(workspaceId, id, runId);
  if (!snapshot) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  return NextResponse.json({ ok: true, ...snapshot });
}
