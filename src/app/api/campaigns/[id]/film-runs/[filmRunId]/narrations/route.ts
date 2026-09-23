import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadCampaign } from "@/server/campaigns";
import { pumpNarrationJob, submitNarrationJob } from "@/server/livepeer/narration-pump";
import { newRunKey } from "@/lib/idempotency-key";

export const dynamic = "force-dynamic";

/**
 * Submit a narration job for a completed reel. Fast: the durable job is
 * created synchronously and the request returns its id; the detached pump
 * runs TTS-then-mux. Repeats with the same idempotencyKey replay the
 * existing job - never a second paid flow.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; filmRunId: string }> }) {
  const { id, filmRunId } = await params;
  const body = await request.json().catch(() => ({}));
  const idempotencyKey =
    typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()
      ? body.idempotencyKey.trim()
      : newRunKey("filmnar");
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
  const submitted = await submitNarrationJob({
    workspaceId,
    campaignId: id,
    filmRunId,
    script: body.script,
    narrationCapUsd: body.narrationCapUsd,
    idempotencyKey
  });
  if (!submitted.job) return NextResponse.json({ error: submitted.error ?? "Narration submission failed" }, { status: 400 });
  if (submitted.created) {
    void pumpNarrationJob(workspaceId, id, filmRunId, submitted.job.id).catch(() => undefined);
  }
  return NextResponse.json({ started: true, narrationJobId: submitted.job.id, created: submitted.created });
}
