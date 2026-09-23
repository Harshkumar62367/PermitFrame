import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadCampaign } from "@/server/campaigns";
import { findNarrationJobView } from "@/server/livepeer/narration-pump";
import { FILM_NARRATION_LABELS } from "@/server/livepeer/narration-policy";

export const dynamic = "force-dynamic";

/**
 * Narration job status. Strictly read-only: phases advance only through
 * the detached pump, so this route never dispatches provider work.
 * The narration script text is withheld from the view - only its hash,
 * estimate, and outcome metadata travel.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; filmRunId: string; narrationJobId: string }> }
) {
  const { id, filmRunId, narrationJobId } = await params;
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
  const job = findNarrationJobView(campaign, filmRunId, narrationJobId);
  if (!job) return NextResponse.json({ error: "Narration job not found" }, { status: 404 });
  return NextResponse.json({ ok: true, narrationJob: job, label: FILM_NARRATION_LABELS[job.status] });
}
