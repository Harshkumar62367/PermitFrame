import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadCampaignEventsNormalized } from "@/server/campaign-store";
import { findCampaign, campaignTimeline } from "@/server/platform";
import { scrubStoredText } from "@/server/dkg/public-errors";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let workspaceId: string;
  try {
    ({ workspaceId } = await requireCurrentSession());
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    throw error;
  }
  // Hot path: indexed, LIMIT-bound event rows. Falls back to the blob only
  // for pre-backfill workspaces.
  const normalized = await loadCampaignEventsNormalized(workspaceId, id, 50).catch(() => null);
  if (normalized && normalized.length > 0) {
    const campaign = await findCampaign(id).catch(() => null);
    const comments = (campaign?.comments ?? []).map((c) => ({ kind: "comment", at: c.at, summary: `${c.author}: ${c.text}`, id: c.id }));
    // System entries predate server-side sanitization in older rows: scrub
    // operational detail at read time. User comments are never touched.
    const evts = normalized.map((e) => ({
      kind: e.kind,
      at: e.at,
      summary: scrubStoredText(e.summary, "Recorded entry unavailable - diagnostic detail was withheld."),
      id: e.id
    }));
    return NextResponse.json({ timeline: [...evts, ...comments].sort((a, b) => a.at.localeCompare(b.at)).reverse() });
  }
  const campaign = await findCampaign(id);
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  const entries = await campaignTimeline(campaign);
  return NextResponse.json({
    timeline: entries.map((entry) =>
      entry.kind === "comment"
        ? entry
        : { ...entry, summary: scrubStoredText(entry.summary, "Recorded entry unavailable - diagnostic detail was withheld.") }
    )
  });
}
