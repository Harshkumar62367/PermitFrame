import { NextRequest, NextResponse } from "next/server";
import { createVariationRun } from "@/server/campaigns";

export const dynamic = "force-dynamic";

/**
 * Explicit "Create variations" refinement: derive additional image assets
 * from one selected completed output. One exact-job run covers all
 * derivatives (progress reads 2/2, ledger one entry per job); each
 * derivative keeps its own idempotency key and provider call, and the
 * original output is never modified. 120s budget - the call returns after
 * the run starts, not after rendering.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { receiptId?: string; count?: number };
  try {
    body = (await request.json()) as { receiptId?: string; count?: number };
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body.receiptId) {
    return NextResponse.json({ error: "receiptId is required" }, { status: 400 });
  }
  const result = await createVariationRun(id, body.receiptId, body.count ?? 2);
  if (!result.started) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ started: true, jobIds: result.jobIds, runId: result.runId });
}
