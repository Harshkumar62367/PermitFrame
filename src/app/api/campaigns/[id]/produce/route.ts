import { NextRequest, NextResponse } from "next/server";
import { startProduction } from "@/server/campaigns";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const stageIds = Array.isArray(body.stageIds) ? body.stageIds.filter((s: unknown) => typeof s === "string") : undefined;
  const result = await startProduction(id, body.capabilityOverride, stageIds);
  if (!result.started) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ started: true });
}
