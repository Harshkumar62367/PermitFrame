import { NextResponse } from "next/server";
import { ensureSeed } from "@/server/seed";
import { expiryWarnings } from "@/server/platform";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeed();
  return NextResponse.json({ warnings: await expiryWarnings() });
}
