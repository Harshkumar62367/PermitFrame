import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError } from "@/server/auth";
import { startProduction } from "@/server/campaigns";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const stageIds = Array.isArray(body.stageIds) ? body.stageIds.filter((s: unknown) => typeof s === "string") : undefined;
  let result;
  try {
    result = await startProduction(id, body.capabilityOverride, stageIds);
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    throw error;
  }
  if (!result.started) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ started: true });
}
