import { NextRequest, NextResponse } from "next/server";
import { approveCampaign } from "@/server/campaigns";

export const dynamic = "force-dynamic";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await approveCampaign(id);
  if (!result.approved) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ approved: true, campaignUAL: result.ual });
}
