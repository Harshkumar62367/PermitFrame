import { NextResponse } from "next/server";
import { loadDb } from "@/server/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = await loadDb();
  return NextResponse.json({
    campaigns: db.campaigns.map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      platform: c.request.platform,
      country: c.request.country,
      contextNote: c.contextNote,
      updatedAt: c.updatedAt
    })),
    creators: db.creators
  });
}
