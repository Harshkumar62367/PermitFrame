import { NextRequest, NextResponse } from "next/server";
import { ensureSeed } from "@/server/seed";
import { loadDb } from "@/server/store";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeed();
  const db = loadDb();
  return NextResponse.json({
    invites: db.consentInvites,
    passports: db.passports.map((p) => ({ id: p.id, creatorId: p.creatorId, ual: p.ual ?? null }))
  });
}
