import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadCampaign } from "@/server/campaigns";
import { cancelNarrationJob } from "@/server/livepeer/narration-pump";

export const dynamic = "force-dynamic";

/**
 * Cancel one narration job: best-effort cancel of tracked phase ids only,
 * then local terminal marking. The original reel, receipts, captions, and
 * all other campaign state are never touched.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; filmRunId: string; narrationJobId: string }> }
) {
  const { id, filmRunId, narrationJobId } = await params;
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
  const job = campaign.filmRuns?.find((r) => r.id === filmRunId)?.narrationJobs?.find((j) => j.id === narrationJobId);
  if (!job) return NextResponse.json({ error: "Narration job not found" }, { status: 404 });
  const result = await cancelNarrationJob(workspaceId, id, filmRunId, narrationJobId);
  return NextResponse.json({ ok: result.cancelled, ...result });
}
