import { NextRequest, NextResponse } from "next/server";
import { loadCampaign } from "@/server/campaigns";
import { loadDb, nowIso, sha256 } from "@/server/store";
import { hasSharableReceipt } from "@/server/types";

export const dynamic = "force-dynamic";

/** Downloadable proof bundle: what PermitFrame recorded, without raw prompts. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const campaign = await loadCampaign(id);
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  // Final delivery only: previews and unsaved outputs have no bundle yet.
  if (!campaign.receipts.some((r) => hasSharableReceipt(r))) {
    return NextResponse.json({ error: "No ready-to-share outputs yet — the proof bundle unlocks once durable storage confirms an output." }, { status: 409 });
  }
  const db = await loadDb();

  const payload = {
    product: "PermitFrame proof bundle",
    generatedAt: nowIso(),
    disclaimer:
      "Proves what PermitFrame recorded (declarations, permissions, evidence, lineage). URL fingerprints correlate records only — they prove nothing about the media bytes. Not a legal ownership certificate.",
    campaign: {
      id: campaign.id,
      title: campaign.title,
      brand: campaign.brand,
      productName: campaign.productName,
      request: campaign.request,
      status: campaign.status,
      createdAt: campaign.createdAt
    },
    policyDecision: campaign.preflight
      ? {
          decision: campaign.preflight.decision,
          blockers: campaign.preflight.blockers,
          allowedClaims: campaign.preflight.allowedClaims,
          promptConstraints: campaign.preflight.promptConstraints,
          queriedRights: campaign.preflight.queriedRights,
          queriedFacts: campaign.preflight.queriedFacts
        }
      : null,
    production: campaign.jobs.map((j) => ({
      stageId: j.stageId,
      kind: j.kind,
      capability: j.capability,
      status: j.status,
      outputUrl: j.outputUrl,
      // Fingerprint of the provider URL string for correlation only — it
      // proves nothing about the media bytes. Durable identity, when stored,
      // is the receipt's Cloudinary public ID / delivery URL below.
      providerUrlFingerprint: j.providerUrlFingerprint ?? j.outputHash ?? null,
      livepeerJobId: j.livepeerJobId,
      costUsd: j.costUsd,
      finishedAt: j.finishedAt,
      promptHash: sha256(j.prompt)
    })),
    receipts: campaign.receipts.map(({ outputHash, ...r }) => ({
      ...r,
      // Same URL-fingerprint value under its honest name (see production above).
      providerUrlFingerprint: r.providerUrlFingerprint ?? outputHash ?? null
    })),
    auditEvents: db.events.filter((e) => e.refs.includes(id))
  };

  return NextResponse.json(payload, {
    headers: { "Content-Disposition": `attachment; filename="campaign-${id}-proof-bundle.json"` }
  });
}
