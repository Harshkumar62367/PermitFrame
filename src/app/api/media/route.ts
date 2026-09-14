import { NextRequest, NextResponse } from "next/server";
import { ensureSeed } from "@/server/seed";
import { loadDb } from "@/server/store";
import { registerSourceMedia } from "@/server/platform";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeed();
  return NextResponse.json({ media: (await loadDb()).sourceMedia });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  if (!body.url?.trim().startsWith("http")) return NextResponse.json({ error: "A public https URL is required" }, { status: 400 });
  const db = await loadDb();
  const creator = db.creators.find((c) => c.id === body.creatorId) ?? db.creators[0];
  if (!creator) return NextResponse.json({ error: "No creator in workspace" }, { status: 400 });
  const media = await registerSourceMedia({
    creatorId: creator.id,
    title: body.title,
    url: body.url,
    type: body.type === "video" ? "video" : "image"
  });
  return NextResponse.json({ media });
}
