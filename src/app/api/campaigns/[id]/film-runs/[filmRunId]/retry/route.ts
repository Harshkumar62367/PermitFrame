import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadCampaign } from "@/server/campaigns";
import { pumpFilmRun } from "@/server/livepeer/film-pump";
import { withCampaignLock } from "@/server/livepeer/mutex";
import { writeWorkspace } from "@/server/livepeer/run-store";
import type { Database } from "@/server/types";

export const dynamic = "force-dynamic";

/**
 * Resume a source-bound Film safely. Completed clips stay attached to the
 * run; the pump only requeues failed scene clips, or retries final assembly.
 * Legacy creative-job runs with a tracked provider job remain non-retryable.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string; filmRunId: string }> }) {
  const { id, filmRunId } = await params;
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
  const run = campaign.filmRuns?.find((r) => r.id === filmRunId);
  if (!run) return NextResponse.json({ error: "Film run not found" }, { status: 404 });
  if (run.status !== "failed") {
    return NextResponse.json({ error: `Only failed film runs can resume - this run is ${run.status}.` }, { status: 400 });
  }
  if (run.providerJobId) {
    return NextResponse.json(
      { error: "This legacy film run already reached the provider - resuming cannot recover it. Submit a new film run for a fresh provider job." },
      { status: 400 }
    );
  }
  await withCampaignLock(id, () =>
    writeWorkspace(workspaceId, (d: Database) => {
      const r = d.campaigns.find((x) => x.id === id)?.filmRuns?.find((x) => x.id === filmRunId);
      if (!r || r.status !== "failed" || r.providerJobId) return;
      r.status = "confirmed";
      r.error = undefined;
      r.finishedAt = undefined;
      // A terminal assembly id cannot produce a new reel on a later poll.
      // Preserve every completed scene URL; the source-bound pump will
      // reassemble them once instead of regenerating them.
      r.assemblyJobId = undefined;
      r.assemblyClaimedAt = undefined;
    })
  );
  void pumpFilmRun(workspaceId, id, filmRunId, { budgetMs: 8 * 60 * 1000 }).catch(() => undefined);
  return NextResponse.json({ ok: true, filmRunId });
}
