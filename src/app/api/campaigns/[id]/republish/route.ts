import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError } from "@/server/auth";
import { getDkg } from "@/server/dkg";
import { receiptKa } from "@/server/dkg/schemas";
import { hasSharableReceipt } from "@/server/types";
import { loadDb, newId, nowIso, updateDb } from "@/server/store";

export const dynamic = "force-dynamic";

/** Re-publish any receipts that were stored locally (e.g. the DKG node was down at generation time). */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let db;
  try {
    db = await loadDb();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    throw error;
  }
  const campaign = db.campaigns.find((c) => c.id === id);
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });

  const republished: string[] = [];
  for (const receipt of campaign.receipts) {
    // Proof only for durable outputs: provider-hosted legacy receipts wait
    // for "Store securely" instead of publishing previews as evidence.
    if (receipt.ual || !hasSharableReceipt(receipt)) continue;
    try {
      const record = await getDkg().publish(receiptKa(receipt), receipt.visibility);
      await updateDb((d) => {
        const c = d.campaigns.find((x) => x.id === id);
        const r = c?.receipts.find((x) => x.id === receipt.id);
        if (r) {
          r.ual = record.ual;
          r.ualExplorer = record.explorerUrl;
          r.publicationStatus = record.publicationStatus;
        }
      });
      republished.push(receipt.id);
    } catch {
      // leave unpublished but record the failed attempt so the UI can offer retry
      await updateDb((d) => {
        const r = d.campaigns.find((x) => x.id === id)?.receipts.find((x) => x.id === receipt.id);
        if (r) r.publicationStatus = "failed";
      }).catch(() => undefined);
    }
  }
  await updateDb((d) => {
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "dkg.republish",
      summary: `Re-published ${republished.length} receipt(s) to the proof ledger.`,
      refs: [id]
    });
  });
  return NextResponse.json({ republished });
}
