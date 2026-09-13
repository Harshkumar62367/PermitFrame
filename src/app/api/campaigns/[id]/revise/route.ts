import { NextRequest, NextResponse } from "next/server";
import { reviseStage } from "@/server/campaigns";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json()) as { stageId: string; instructions: string };
  if (!body.stageId || !body.instructions?.trim()) {
    return NextResponse.json({ error: "stageId and instructions are required" }, { status: 400 });
  }
  const result = await reviseStage(id, body.stageId, body.instructions);
  if (!result.started) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ started: true });
}
