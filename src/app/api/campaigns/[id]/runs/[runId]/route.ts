import { after, NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadCampaign } from "@/server/campaigns";
import { getRunStatusSnapshot, pumpRun } from "@/server/livepeer/runner";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

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
  // A request that created the durable run may have ended before its worker
  // started. A queued exact-job run needs a full dispatch pump to resume.
  if (snapshot.run.status === "active" && snapshot.jobs.some((job) => job.status === "queued")) {
    after(() => pumpRun(workspaceId, id, { runId, budgetMs: 8 * 60 * 1000 }).catch(() => console.error("Run pump failed")));
  }
  return NextResponse.json({ ok: true, ...snapshot });
}
