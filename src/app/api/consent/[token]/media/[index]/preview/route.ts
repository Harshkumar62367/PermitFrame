import { NextRequest, NextResponse } from "next/server";
import { loadInviteContext } from "@/server/store";
import { PREVIEW_NOT_FOUND, PREVIEW_UNAVAILABLE, resolveConsentPreviewMediaId, serveSourcePreview } from "@/server/source-preview";

export const dynamic = "force-dynamic";

/**
 * Token-scoped preview for a private uploaded image covered by one consent
 * request. The bearer link is the capability: it can view only the active
 * request's listed image at an opaque position. The browser receives
 * same-origin bytes only; storage identifiers and temporary Cloudinary URLs
 * are resolved and fetched server-side by serveSourcePreview.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string; index: string }> }
) {
  const { token, index: rawIndex } = await params;
  const ctx = await loadInviteContext(token);
  const invite = ctx?.db.consentInvites.find((candidate) => candidate.token === token);
  const index = /^\d+$/.test(rawIndex) ? Number(rawIndex) : -1;
  const mediaId = ctx && invite ? resolveConsentPreviewMediaId(ctx.db, invite, index) : null;
  if (!ctx || !mediaId) return NextResponse.json({ error: PREVIEW_NOT_FOUND }, { status: 404 });

  const result = await serveSourcePreview(ctx.db, mediaId);
  if (result.status === 200) return result.response;
  if (result.status === 404) return NextResponse.json({ error: PREVIEW_NOT_FOUND }, { status: 404 });
  return NextResponse.json({ error: PREVIEW_UNAVAILABLE }, { status: 503 });
}
