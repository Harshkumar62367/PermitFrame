import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadCampaign } from "@/server/campaigns";
import { cancelCaptionJob } from "@/server/livepeer/film-caption-pump";

export const dynamic = "force-dynamic";

/**
 * Cancel one caption job: best-effort cancel of the tracked provider job
 * only, then local terminal marking. The original reel, receipts, and all
 * other campaign state are never touched.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; filmRunId: string; captionJobId: string }> }
) {
  const { id, filmRunId, captionJobId } = await params;
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
  const job = campaign.filmRuns?.find((r) => r.id === filmRunId)?.captionJobs?.find((j) => j.id === captionJobId);
  if (!job) return NextResponse.json({ error: "Caption job not found" }, { status: 404 });
  const result = await cancelCaptionJob(workspaceId, id, filmRunId, captionJobId);
  return NextResponse.json({ ok: result.cancelled, ...result });
}
