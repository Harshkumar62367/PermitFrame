import { NextRequest, NextResponse } from "next/server";
import { cloneForPlatforms } from "@/server/platform";
import type { Platform } from "@/server/types";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();
  const platforms: Platform[] = body.platforms ?? [];
  if (!Array.isArray(platforms) || platforms.length === 0) {
    return NextResponse.json({ error: "platforms array is required" }, { status: 400 });
  }
  try {
    const campaigns = await cloneForPlatforms(id, platforms);
    return NextResponse.json({ campaigns });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
