import { NextRequest, NextResponse } from "next/server";
import { ensureSeed } from "@/server/seed";
import { loadDb } from "@/server/store";
import { findCampaign } from "@/server/platform";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ensureSeed();
  const { id } = await params;
  const campaign = findCampaign(id);
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  const db = loadDb();
  return NextResponse.json({
    campaign,
    sourceMedia: db.sourceMedia.find((m) => m.id === campaign.sourceMediaId) ?? null,
    passport: db.passports.find((p) => p.id === campaign.passportId) ?? null,
    productFacts: db.productFacts.find((f) => f.id === campaign.productFactsId) ?? null
  });
}
