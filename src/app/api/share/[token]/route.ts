import { NextRequest, NextResponse } from "next/server";
import { clientReview, resolveShare } from "@/server/platform";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const campaign = await resolveShare(token);
  if (!campaign) return NextResponse.json({ error: "Share link not found" }, { status: 404 });
  return NextResponse.json({
    campaign: {
      id: campaign.id,
      title: campaign.title,
      brand: campaign.brand,
      productName: campaign.productName,
      status: campaign.status,
      comments: (campaign.comments ?? []).filter((c) => c.author === "client"),
      preflight: campaign.preflight
        ? { decision: campaign.preflight.decision, allowedClaims: campaign.preflight.allowedClaims }
        : null
    },
    receipts: campaign.receipts.map((r) => ({
      id: r.id,
      label: r.label,
      mediaType: r.mediaType,
      format: r.format,
      outputUrl: r.outputUrl,
      verifyUrl: `/verify/${r.id}`
    }))
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const body = await request.json();
  if (!["approved", "changes_requested"].includes(body.decision)) {
    return NextResponse.json({ error: "decision must be approved or changes_requested" }, { status: 400 });
  }
  try {
    const campaign = await clientReview(token, {
      decision: body.decision,
      clientName: body.clientName,
      comment: body.comment
    });
    return NextResponse.json({ status: campaign.status });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
