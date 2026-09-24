import { NextResponse } from "next/server";

/**
 * Public process-liveness probe for hosting platforms.
 *
 * This must stay cheap and dependency-free: it intentionally does not read
 * authentication, Neon, DKG, or Livepeer state. The signed-in application
 * uses /api/health for integration status instead.
 */
export function GET() {
  return NextResponse.json({ ok: true });
}

