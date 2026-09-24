import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadDb } from "@/server/store";
import { PREVIEW_NOT_FOUND, PREVIEW_UNAVAILABLE, serveSourcePreview } from "@/server/source-preview";
import { logDkgError } from "@/server/dkg/public-errors";

export const dynamic = "force-dynamic";

/**
 * Same-origin authenticated preview for uploaded source images.
 *
 * Session-scoped: the workspace comes from the session cookie and only
 * that workspace's rows are visible, so one workspace can never fetch
 * another's uploads by guessing an id. Uploaded images stream back as
 * opaque same-origin bytes (`Cache-Control: private, no-store`); every
 * other case - missing, foreign, URL-registered, video, malformed - gets
 * the same 404. The Cloudinary temporary download URL is minted and
 * fetched server-side only: no redirect, no Cloudinary identifiers, hashes,
 * storage metadata, or provider text in responses, logs, or errors.
 * Workspace review only - the Livepeer generation handoff is untouched.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireCurrentSession();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    throw error;
  }
  let db;
  try {
    db = await loadDb();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    throw error;
  }
  const { id } = await params;
  try {
    const result = await serveSourcePreview(db, id);
    if (result.status === 200) return result.response;
    if (result.status === 404) return NextResponse.json({ error: PREVIEW_NOT_FOUND }, { status: 404 });
    return NextResponse.json({ error: PREVIEW_UNAVAILABLE }, { status: 503 });
  } catch {
    // Static text only: a raw failure could echo the temporary URL.
    logDkgError("media-preview", "preview request failed");
    return NextResponse.json({ error: PREVIEW_UNAVAILABLE }, { status: 503 });
  }
}
