import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadCampaign } from "@/server/campaigns";
import { findCaptionJobView } from "@/server/livepeer/film-caption-pump";
import { FILM_CAPTION_LABELS } from "@/server/livepeer/film-captions";

export const dynamic = "force-dynamic";

/**
 * Caption job status. Strictly read-only: the transcribe call cannot be
 * polled (no status tool exists), so this route never dispatches provider
 * work - it returns the stored record. Transcripts, receipts, and reel
 * links surface only when actually recorded.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; filmRunId: string; captionJobId: string }> }
) {
  const { id, filmRunId, captionJobId } = await params;
  try {
    await requireCurrentSession();
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
  return NextResponse.json({ ok: true, captionJob: job, label: FILM_CAPTION_LABELS[job.status] });
}
