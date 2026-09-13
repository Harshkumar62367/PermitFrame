import { NextRequest, NextResponse } from "next/server";
import { startProduction } from "@/server/campaigns";

export const dynamic = "force-dynamic";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await startProduction(id);
  if (!result.started) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ started: true });
}
