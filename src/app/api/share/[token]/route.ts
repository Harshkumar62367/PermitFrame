import { NextRequest, NextResponse } from "next/server";
import { appendShareReview, lookupShare, ShareNotFoundError } from "@/server/public-share";

export const dynamic = "force-dynamic";

/**
 * Public share API. Session-free by design: both reads and review submits
 * work logged out. Responses carry ONLY the whitelisted public view — the
 * legacy shape (full campaign fields, receipt-id verify links) is gone.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await lookupShare(token);
  if (!result.found) return NextResponse.json({ error: "Share link not found" }, { status: 404 });
  return NextResponse.json({ view: result.view });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const body = await request.json().catch(() => ({}));
  if (!["approved", "changes_requested"].includes(body.decision)) {
    return NextResponse.json({ error: "decision must be approved or changes_requested." }, { status: 400 });
  }
  if (typeof body.comment === "string" && body.comment.length > 2000) {
    return NextResponse.json({ error: "comment must be under 2000 characters." }, { status: 400 });
  }
  try {
    return NextResponse.json(await appendShareReview(token, {
      decision: body.decision,
      clientName: typeof body.clientName === "string" ? body.clientName : undefined,
      comment: typeof body.comment === "string" ? body.comment : undefined
    }));
  } catch (e) {
    if (e instanceof ShareNotFoundError) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
