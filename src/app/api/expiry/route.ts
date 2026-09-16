import { NextResponse } from "next/server";
import { expiryWarnings } from "@/server/platform";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ warnings: await expiryWarnings() });
}
