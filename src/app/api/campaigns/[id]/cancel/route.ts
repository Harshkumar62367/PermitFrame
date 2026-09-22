import { NextRequest, NextResponse } from "next/server";
import { cancelCampaignJobs } from "@/server/campaigns";

export const dynamic = "force-dynamic";

/**
 * Cancel queued/in-flight jobs. Undispatched rows cancel locally;
 * dispatched rows get a real provider attempt and are marked only on
 * provider confirmation - refusals keep the job with an honest note.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const jobIds = Array.isArray(body.jobIds) ? body.jobIds.filter((s: unknown) => typeof s === "string") : undefined;
  const result = await cancelCampaignJobs(id, jobIds);
  if (result.error) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, results: result.results });
}
