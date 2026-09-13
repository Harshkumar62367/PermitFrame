import { NextRequest, NextResponse } from "next/server";
import { findCampaign, campaignTimeline } from "@/server/platform";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const campaign = findCampaign(id);
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  return NextResponse.json({ timeline: campaignTimeline(campaign) });
}
