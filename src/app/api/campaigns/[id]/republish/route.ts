import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError } from "@/server/auth";
import { anchorReceipts } from "@/server/receipt-publication";
import { loadDb } from "@/server/store";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";

export const dynamic = "force-dynamic";

/**
 * Anchor shareable derivative receipts in on-chain Verifiable Memory.
 * Optional body `{ receiptIds }` processes one batch (the review UI drives
 * per-receipt calls for honest progress); omitted ids mean every receipt on
 * the campaign. Only genuinely finalized records count as published -
 * Shared Working Memory evidence and local-evidence locators never do.
 * Per-receipt states persist (publishing -> anchored | failed), so refreshes
 * and timeouts surface the durable outcome instead of resetting it.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { receiptIds?: unknown };
  const receiptIds = Array.isArray(body.receiptIds)
    ? body.receiptIds.filter((v): v is string => typeof v === "string")
    : undefined;
  let db;
  try {
    db = await loadDb();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    throw error;
  }
  if (!db.campaigns.some((c) => c.id === id)) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  try {
    const { results } = await anchorReceipts({ campaignId: id, receiptIds });
    // "published" means anchored only: already-anchored, skipped, failed,
    // and in-flight records are never counted here.
    const republished = results.filter((r) => r.status === "anchored").map((r) => r.receiptId);
    return NextResponse.json({ results, republished });
  } catch (error) {
    logDkgError("republish", error);
    const safe = sanitizeDkgError(error, "mutation");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
