import { NextRequest, NextResponse } from "next/server";
import { createShareLink } from "@/server/platform";

export const dynamic = "force-dynamic";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const token = await createShareLink(id);
    return NextResponse.json({ token, url: `/share/${token}` });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
