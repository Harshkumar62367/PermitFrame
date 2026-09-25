import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError } from "@/server/auth";
import { startProduction } from "@/server/campaigns";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const stageIds = Array.isArray(body.stageIds) ? body.stageIds.filter((s: unknown) => typeof s === "string") : undefined;
  const jobIds = Array.isArray(body.jobIds) ? body.jobIds.filter((s: unknown) => typeof s === "string") : undefined;
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
  const retryMode = body.retryMode === "backup" || body.retryMode === "same" ? body.retryMode : undefined;
  const confirmUnknownSpend = body.confirmUnknownSpend === true;
  let result;
  try {
    result = await startProduction(id, body.capabilityOverride, stageIds, idempotencyKey, jobIds, retryMode, confirmUnknownSpend);
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    throw error;
  }
  if (!result.started) return NextResponse.json({ error: result.error }, { status: 400 });
  // Fast submit: records + run id return now; the pump executes detached and
  // the client follows progress on the run endpoint (or reloads anytime).
  return NextResponse.json({ started: true, runId: result.runId });
}
