import { NextRequest, NextResponse } from "next/server";
import { loadDb } from "@/server/store";
import { reconcileCampaignStatus } from "@/server/campaign-status";
import { findCampaign } from "@/server/platform";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const campaign = await findCampaign(id);
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  // Self-healing read: a stored status that drifted from the live preflight
  // verdict is corrected here, so badges can never contradict the verdict.
  await reconcileCampaignStatus(campaign).catch(() => undefined);
  const db = await loadDb();
  return NextResponse.json({
    campaign,
    sourceMedia: db.sourceMedia.find((m) => m.id === campaign.sourceMediaId) ?? null,
    passport: db.passports.find((p) => p.id === campaign.passportId) ?? null,
    productFacts: db.productFacts.find((f) => f.id === campaign.productFactsId) ?? null
  });
}
