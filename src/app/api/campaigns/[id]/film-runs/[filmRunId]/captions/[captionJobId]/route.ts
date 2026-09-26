import { after, NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadCampaign } from "@/server/campaigns";
import { findCaptionJobView, pumpCaptionJob } from "@/server/livepeer/film-caption-pump";
import { FILM_CAPTION_LABELS } from "@/server/livepeer/film-captions";

export const dynamic = "force-dynamic";
export const maxDuration = 630;

/**
 * Caption job status. The transcribe call cannot be polled. A queued job
 * may be safely started after this response (the pump claims it atomically);
 * a claimed transcribing job is never submitted again.
 */
export async function GET(
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
  const job = findCaptionJobView(campaign, filmRunId, captionJobId);
  if (!job) return NextResponse.json({ error: "Caption job not found" }, { status: 404 });
  if (job.status === "queued" && !job.dispatchStartedAt) {
    after(() => pumpCaptionJob(workspaceId, id, filmRunId, captionJobId).catch(() => console.error("Caption pump failed")));
  }
  return NextResponse.json({ ok: true, captionJob: job, label: FILM_CAPTION_LABELS[job.status] });
}
