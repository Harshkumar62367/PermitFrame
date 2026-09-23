import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadCampaign } from "@/server/campaigns";
import { pumpNarrationJob, recoverNarrationJob, narrationRecoverHttpOutcome } from "@/server/livepeer/narration-pump";

export const dynamic = "force-dynamic";

/**
 * Explicit unknown-outcome recovery (user-confirmed only - this route is
 * the sole path): preserve the stale claimed job as a terminal
 * outcome-unknown record, then queue ONE fresh narration job with fresh
 * ids and phase idempotency keys. The detached pump fires ONLY for the
 * persisted fresh job id; a concurrent loser answers 409 and pumps
 * nothing. Never a retry, never a resubmit of the uncertain record.
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
  const recovered = await recoverNarrationJob(workspaceId, id, filmRunId, narrationJobId);
  if (!recovered.ok) {
    const outcome = narrationRecoverHttpOutcome(recovered);
    return NextResponse.json(outcome.body, { status: outcome.status });
  }
  void pumpNarrationJob(workspaceId, id, filmRunId, recovered.job.id).catch(() => undefined);
  return NextResponse.json({ ok: true, narrationJobId: recovered.job.id, recoveredFrom: recovered.recoveredFrom });
}
