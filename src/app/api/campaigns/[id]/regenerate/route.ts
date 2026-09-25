import { NextRequest, NextResponse } from "next/server";
import { regenerateRatioMismatch } from "@/server/campaigns";

export const dynamic = "force-dynamic";

/** Explicit paid replacement only for a measured, delivery-blocked ratio mismatch. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({} as { receiptId?: unknown }));
  if (typeof body.receiptId !== "string" || !body.receiptId) {
    return NextResponse.json({ error: "receiptId is required" }, { status: 400 });
  }
  const result = await regenerateRatioMismatch(id, body.receiptId);
  if (!result.started) return NextResponse.json({ error: result.error ?? "Regeneration could not start" }, { status: 400 });
  return NextResponse.json({ started: true, jobId: result.jobId, runId: result.runId });
}
