import { NextResponse } from "next/server";
import { ensureSeed } from "@/server/seed";
import { loadDb } from "@/server/store";
import { getDkg } from "@/server/dkg";
import { livepeerConfig } from "@/server/livepeer/mcp-client";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeed();
  const db = await loadDb();
  const dkgHealth = await getDkg().health();
  return NextResponse.json({
    campaigns: db.campaigns.map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      platform: c.request.platform,
      country: c.request.country,
      demoNote: c.demoNote,
      updatedAt: c.updatedAt
    })),
    creators: db.creators,
    dkg: dkgHealth,
    livepeer: { endpoint: livepeerConfig().endpoint, keyless: !livepeerConfig().bearer }
  });
}
