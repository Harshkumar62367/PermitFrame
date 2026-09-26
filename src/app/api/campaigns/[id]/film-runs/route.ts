import { after, NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadCampaign } from "@/server/campaigns";
import { pumpFilmRun, submitFilmRun } from "@/server/livepeer/film-pump";
import { newRunKey } from "@/lib/idempotency-key";
import { redactSecrets } from "@/server/dkg/edge-node-adapter";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

/** Check an uncertain submit by its stable client key after a timeout or reload. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await requireCurrentSession();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    throw error;
  }
  const key = request.nextUrl.searchParams.get("idempotencyKey")?.trim();
  if (!key) return NextResponse.json({ error: "Submission key is required" }, { status: 400 });
  const campaign = await loadCampaign(id);
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  const run = campaign.filmRuns?.find((item) => item.idempotencyKey === key);
  return NextResponse.json({ found: Boolean(run), filmRunId: run?.id ?? null, status: run?.status ?? null });
}

/**
 * Submit a film run from the saved (confirmed) film plan. Fast: the
 * durable run is created synchronously and the request returns its id;
 * the detached pump submits the provider job, honors the staged gate, and
 * polls to completion. Repeats with the same idempotencyKey replay the
 * existing run - never a second paid provider job.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const idempotencyKey =
    typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()
      ? body.idempotencyKey.trim()
      : newRunKey("film");
  let workspaceId: string;
  try {
    workspaceId = (await requireCurrentSession()).workspaceId;
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    throw error;
  }
  const submitted = await submitFilmRun({ workspaceId, campaignId: id, idempotencyKey });
  if (!submitted.run) return NextResponse.json({ error: submitted.error ?? "Film submission failed" }, { status: 400 });
  if (submitted.created) {
    const filmRunId = submitted.run.id;
    after(() => pumpFilmRun(workspaceId, id, filmRunId, { budgetMs: 8 * 60 * 1000 }).catch((error) => {
      console.error("[film-run:pump]", redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500));
    }));
  }
  return NextResponse.json({ started: true, filmRunId: submitted.run.id, created: submitted.created });
}
