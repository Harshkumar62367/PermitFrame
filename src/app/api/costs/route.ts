import { NextResponse } from "next/server";
import { loadDb } from "@/server/store";
import { effectiveCampaignStatus } from "@/server/campaign-status";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = await loadDb();
  const perCampaign = db.campaigns.map((c) => {
    const succeeded = c.jobs.filter((j) => j.status === "ready_to_share");
    return {
      campaignId: c.id,
      title: c.title,
      spent: succeeded.reduce((s, j) => s + (j.costUsd ?? 0), 0),
      outputs: succeeded.length,
      // Derived from the live preflight verdict, not the stored label.
      blocked: effectiveCampaignStatus(c) === "blocked"
    };
  });
  return NextResponse.json({
    perCampaign,
    totalSpent: perCampaign.reduce((s, c) => s + c.spent, 0)
  });
}
