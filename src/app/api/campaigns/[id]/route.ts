import { NextRequest, NextResponse } from "next/server";
import { loadDb } from "@/server/store";
import { reconcileCampaignStatus } from "@/server/campaign-status";
import { findCampaign } from "@/server/platform";
import { updateCampaignBrief, type BriefPatch } from "@/server/campaigns";

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

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as BriefPatch;
  const allowed: (keyof BriefPatch)[] = [
    "title",
    "creativeBrief",
    "objective",
    "primaryMessage",
    "visualDirection",
    "requestedClaims",
    "platform",
    "country",
    "transformation",
    "sourceMediaId"
  ];
  const patch: BriefPatch = {};
  for (const key of allowed) {
    const value = body[key];
    if (value !== undefined) (patch as Record<string, unknown>)[key] = value;
  }
  if (patch.requestedClaims !== undefined && !Array.isArray(patch.requestedClaims)) {
    return NextResponse.json({ error: "requestedClaims must be an array of strings." }, { status: 400 });
  }
  const result = await updateCampaignBrief(id, patch);
  if (!result.campaign) return NextResponse.json({ error: result.error ?? "Update failed." }, { status: 400 });
  return NextResponse.json({ campaign: result.campaign });
}
