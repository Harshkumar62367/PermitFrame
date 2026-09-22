import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadCampaign } from "@/server/campaigns";
import { cancelFilmRun } from "@/server/livepeer/film-pump";

export const dynamic = "force-dynamic";

/**
 * Cancel one film run: cancels ONLY the owned provider job (when tracked
 * and active) and marks the run cancelled. Campaign jobs, receipts, runs,
 * and the saved plan are never touched - prior completed assets survive.
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
  if (!campaign.filmRuns?.some((r) => r.id === filmRunId)) {
    return NextResponse.json({ error: "Film run not found" }, { status: 404 });
  }
  const result = await cancelFilmRun(workspaceId, id, filmRunId);
  return NextResponse.json({ ok: result.cancelled, ...result });
}
