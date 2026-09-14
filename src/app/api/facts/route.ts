import { NextRequest, NextResponse } from "next/server";
import { ensureSeed } from "@/server/seed";
import { loadDb } from "@/server/store";
import { upsertProductFacts } from "@/server/platform";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeed();
  return NextResponse.json({ facts: (await loadDb()).productFacts });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  for (const key of ["brand", "productName"]) {
    if (!body[key]?.trim()) return NextResponse.json({ error: `${key} is required` }, { status: 400 });
  }
  const facts = await upsertProductFacts({
    id: body.id,
    brand: body.brand,
    productName: body.productName,
    approvedClaims: body.approvedClaims ?? [],
    prohibitedClaims: body.prohibitedClaims ?? [],
    guidelines: body.guidelines ?? [],
    evidenceNotes: body.evidenceNotes ?? ""
  });
  return NextResponse.json({ facts });
}
