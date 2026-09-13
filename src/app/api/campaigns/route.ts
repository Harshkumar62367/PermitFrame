import { NextRequest, NextResponse } from "next/server";
import { ensureSeed } from "@/server/seed";
import { loadDb } from "@/server/store";
import { createCampaign } from "@/server/campaigns";
import type { CampaignRequest } from "@/server/types";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeed();
  return NextResponse.json({ campaigns: loadDb().campaigns });
}

export async function POST(request: NextRequest) {
  await ensureSeed();
  const body = (await request.json()) as {
    title: string;
    platform: string;
    country: string;
    requestedClaims: string[];
    transformation: "image" | "video";
    creativeBrief: string;
    brand?: string;
    productName?: string;
  };
  const db = loadDb();
  const creator = db.creators[0];
  const passport = db.passports.find((p) => p.creatorId === creator?.id);
  const facts = db.productFacts.find((f) => f.brand === (body.brand ?? "Verdi Steps"));
  const media = db.sourceMedia.find((m) => m.creatorId === creator?.id);
  if (!creator || !passport || !facts || !media) {
    return NextResponse.json({ error: "Workspace is not initialized" }, { status: 400 });
  }
  const req: CampaignRequest = {
    platform: body.platform as CampaignRequest["platform"],
    country: body.country.toUpperCase().slice(0, 2),
    requestedClaims: body.requestedClaims ?? [],
    transformation: body.transformation ?? "image",
    creativeBrief: body.creativeBrief ?? ""
  };
  const campaign = await createCampaign({
    title: body.title || `${req.platform} campaign — ${req.country}`,
    brand: body.brand ?? facts.brand,
    productName: body.productName ?? facts.productName,
    creatorId: creator.id,
    sourceMediaId: media.id,
    passportId: passport.id,
    productFactsId: facts.id,
    request: req
  });
  return NextResponse.json({ campaign });
}
