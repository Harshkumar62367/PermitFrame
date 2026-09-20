import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError } from "@/server/auth";
import { renewPassport } from "@/server/platform";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.validUntil ?? "")) {
    return NextResponse.json({ error: "validUntil must be YYYY-MM-DD" }, { status: 400 });
  }
  try {
    const passport = await renewPassport(id, body.validUntil);
    if (!passport) return NextResponse.json({ error: "Passport not found" }, { status: 404 });
    return NextResponse.json({ passport });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    throw error;
  }
}
