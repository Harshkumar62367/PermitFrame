import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadCampaign } from "@/server/campaigns";
import { pumpFilmRun } from "@/server/livepeer/film-pump";
import { filmDisplayLabel } from "@/server/livepeer/film-run";

export const dynamic = "force-dynamic";

/**
 * Film run status. Strictly bounded for the UI: a short poll-only pump
 * first (never submits or confirms provider work from a GET), a detached
 * full pump alongside for progress, then the stored run. Scene outputs and
 * the reel URL surface only when actually returned by the provider.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string; filmRunId: string }> }) {
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
  await pumpFilmRun(workspaceId, id, filmRunId, {
    budgetMs: 4000,
    allowSubmit: false,
    allowConfirm: false
  }).catch(() => undefined);
  void pumpFilmRun(workspaceId, id, filmRunId, { budgetMs: 8 * 60 * 1000 }).catch(() => undefined);
  const fresh = (await loadCampaign(id))?.filmRuns?.find((r) => r.id === filmRunId) ?? run;
  return NextResponse.json({
    ok: true,
    filmRun: fresh,
    label: filmDisplayLabel(fresh),
    reelReady: fresh.status === "ready" && typeof fresh.reelUrl === "string"
  });
}
