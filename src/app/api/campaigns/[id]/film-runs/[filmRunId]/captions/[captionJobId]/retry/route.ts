import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadCampaign } from "@/server/campaigns";
import { pumpCaptionJob } from "@/server/livepeer/film-caption-pump";
import { canRetryCaptionJob } from "@/server/livepeer/film-captions";
import { withCampaignLock } from "@/server/livepeer/mutex";
import { writeWorkspace } from "@/server/livepeer/run-store";
import type { Database } from "@/server/types";

export const dynamic = "force-dynamic";

/**
 * Resume a failed caption job that never reached the provider: only jobs
 * with no tracked provider id are eligible (nothing was dispatched, so
 * resuming cannot double-spend). Provider-terminal failures need a fresh
 * confirmation, never a silent resubmit.
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
  // Ordinary retry only: explicitly failed with nothing tracked. Stale
  // claimed jobs (outcome unknown) use the recover endpoint instead.
  const eligible = canRetryCaptionJob(job);
  if (eligible) return NextResponse.json({ error: eligible }, { status: 400 });
  await withCampaignLock(id, () =>
    writeWorkspace(workspaceId, (d: Database) => {
      const target = d.campaigns
        .find((x) => x.id === id)
        ?.filmRuns?.find((x) => x.id === filmRunId)
        ?.captionJobs?.find((x) => x.id === captionJobId);
      if (!target || target.status !== "failed" || target.providerJobId) return;
      target.status = "queued";
      target.error = undefined;
      target.finishedAt = undefined;
    })
  );
  void pumpCaptionJob(workspaceId, id, filmRunId, captionJobId).catch(() => undefined);
  return NextResponse.json({ ok: true, captionJobId });
}
