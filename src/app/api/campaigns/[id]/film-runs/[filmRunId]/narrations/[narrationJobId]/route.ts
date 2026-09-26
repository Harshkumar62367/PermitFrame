import { after, NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadCampaign } from "@/server/campaigns";
import { findNarrationJobView, pumpNarrationJob } from "@/server/livepeer/narration-pump";
import { FILM_NARRATION_LABELS, isTerminalNarrationStatus } from "@/server/livepeer/narration-policy";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

/**
 * Narration job status. The response is a stored snapshot; after it is sent,
 * resume the idempotent pump so subsequent polls can advance long-running
 * TTS/mux jobs even if the original request worker already finished.
 * The narration script text is withheld from the view - only its hash,
 * estimate, and outcome metadata travel.
 */
export async function GET(
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
  const job = findNarrationJobView(campaign, filmRunId, narrationJobId);
  if (!job) return NextResponse.json({ error: "Narration job not found" }, { status: 404 });
  if (!isTerminalNarrationStatus(job.status)) {
    after(() => pumpNarrationJob(workspaceId, id, filmRunId, narrationJobId).catch(() => console.error("Narration pump failed")));
  }
  return NextResponse.json({ ok: true, narrationJob: job, label: FILM_NARRATION_LABELS[job.status] });
}
