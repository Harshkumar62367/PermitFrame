import { after, NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadCampaign } from "@/server/campaigns";
import { pumpCaptionJob, recoverCaptionJob, recoverHttpOutcome } from "@/server/livepeer/film-caption-pump";

export const dynamic = "force-dynamic";
export const maxDuration = 630;

/**
 * Explicit unknown-outcome recovery (user-confirmed only - this route is
 * the sole path): preserve the stale claimed job as a terminal
 * outcome-unknown record, then queue ONE fresh caption job with a fresh
 * idempotency key. The detached pump fires ONLY for the persisted fresh
 * job id; a concurrent loser answers 409 and pumps nothing. Never a
 * retry, never a resubmit of the original provider call.
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
  const recovered = await recoverCaptionJob(workspaceId, id, filmRunId, captionJobId);
  if (!recovered.ok) {
    const outcome = recoverHttpOutcome(recovered);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
  after(() => pumpCaptionJob(workspaceId, id, filmRunId, recovered.job.id).catch(() => console.error("Caption pump failed")));
  return NextResponse.json({ ok: true, captionJobId: recovered.job.id, recoveredFrom: recovered.recoveredFrom });
}
