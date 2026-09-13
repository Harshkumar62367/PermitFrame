import { NextRequest, NextResponse } from "next/server";
import { ensureSeed } from "@/server/seed";
import { loadCampaign } from "@/server/campaigns";
import { loadDb, nowIso, sha256 } from "@/server/store";

export const dynamic = "force-dynamic";

/** Downloadable proof bundle: what PermitFrame recorded, without raw prompts. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ensureSeed();
  const { id } = await params;
  const campaign = loadCampaign(id);
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  const db = loadDb();

  const payload = {
    product: "PermitFrame proof bundle",
    generatedAt: nowIso(),
    disclaimer:
      "Proves what PermitFrame recorded (declarations, permissions, evidence, lineage). Not a legal ownership certificate.",
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
      outputHash: j.outputHash,
      livepeerJobId: j.livepeerJobId,
      costUsd: j.costUsd,
      finishedAt: j.finishedAt,
      promptHash: sha256(j.prompt)
    })),
    receipts: campaign.receipts,
    auditEvents: db.events.filter((e) => e.refs.includes(id))
  };

  return NextResponse.json(payload, {
    headers: { "Content-Disposition": `attachment; filename="campaign-${id}-proof-bundle.json"` }
  });
}
