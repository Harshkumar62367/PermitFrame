import { after, NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadCampaign } from "@/server/campaigns";
import { pumpCaptionJob, submitCaptionJob } from "@/server/livepeer/film-caption-pump";
import { newRunKey } from "@/lib/idempotency-key";

export const dynamic = "force-dynamic";
export const maxDuration = 630;

/**
 * Submit a burn-captions job for a completed reel. Fast: the durable job
 * is created synchronously and the request returns its id; the after-response
 * pump runs the single transcribe call. Repeats with the same
 * idempotencyKey replay the existing job - never a second paid call.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; filmRunId: string }> }) {
  const { id, filmRunId } = await params;
  const body = await request.json().catch(() => ({}));
  const idempotencyKey =
    typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()
      ? body.idempotencyKey.trim()
      : newRunKey("filmcap");
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
  const submitted = await submitCaptionJob({
    workspaceId,
    campaignId: id,
    filmRunId,
    language: body.language,
    narrationJobId: typeof body.narrationJobId === "string" ? body.narrationJobId : undefined,
    idempotencyKey
  });
  if (!submitted.job) return NextResponse.json({ error: submitted.error ?? "Caption submission failed" }, { status: 400 });
  const captionJobId = submitted.job.id;
  if (submitted.created) {
    after(() => pumpCaptionJob(workspaceId, id, filmRunId, captionJobId).catch(() => console.error("Caption pump failed")));
  }
  return NextResponse.json({ started: true, captionJobId, created: submitted.created });
}
