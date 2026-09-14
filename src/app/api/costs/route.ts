import { NextResponse } from "next/server";
import { ensureSeed } from "@/server/seed";
import { loadDb } from "@/server/store";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeed();
  const db = await loadDb();
  const perCampaign = db.campaigns.map((c) => {
    const succeeded = c.jobs.filter((j) => j.status === "succeeded");
    return {
      campaignId: c.id,
      title: c.title,
      spent: succeeded.reduce((s, j) => s + (j.costUsd ?? 0), 0),
      outputs: succeeded.length,
      blocked: c.status === "blocked"
    };
  });
  return NextResponse.json({
    perCampaign,
    totalSpent: perCampaign.reduce((s, c) => s + c.spent, 0)
  });
}
