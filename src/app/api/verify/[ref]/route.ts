import { NextRequest, NextResponse } from "next/server";
import { lookupVerification } from "@/server/verify";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const result = lookupVerification(ref);
  if (!result.found) return NextResponse.json({ error: "Reference not found", ref }, { status: 404 });
  return NextResponse.json(result);
}
