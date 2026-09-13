import { NextRequest, NextResponse } from "next/server";
import { getDkg } from "@/server/dkg";
import { ensureSeed } from "@/server/seed";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeed();
  const dkg = getDkg();
  const health = await dkg.health();
  const assets = await dkg.listAssets().catch(() => []);
  return NextResponse.json({ health, assets });
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as { query: string };
  if (!body.query?.trim()) return NextResponse.json({ error: "query is required" }, { status: 400 });
  const dkg = getDkg();
  try {
    const bindings = await dkg.sparql(body.query);
    return NextResponse.json({ bindings, mode: dkg.mode });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message.slice(0, 400) }, { status: 400 });
  }
}
