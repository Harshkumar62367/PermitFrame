import { after, NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError } from "@/server/auth";
import { reviseStage, startRefinementJob } from "@/server/campaign-variations";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json()) as { stageId: string; instructions: string; jobId?: string; idempotencyKey?: string };
  if (!body.stageId || !body.instructions?.trim()) {
    return NextResponse.json({ error: "stageId and instructions are required" }, { status: 400 });
  }
  let result;
  try {
    result = await reviseStage(id, body.stageId, body.instructions, body.jobId, body.idempotencyKey);
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    throw error;
  }
  if (!result.started) return NextResponse.json({ error: result.error }, { status: 400 });
  const workspaceId = result.workspaceId as string;
  const jobId = result.jobId as string;
  after(() => startRefinementJob(workspaceId, id, jobId, body.idempotencyKey).catch(() => console.error("Refinement pump failed")));
  return NextResponse.json({ started: true, jobId });
}
