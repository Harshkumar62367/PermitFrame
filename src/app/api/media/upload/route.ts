import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { registerUploadedSourceMedia } from "@/server/platform";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";

export const dynamic = "force-dynamic";

/** Absolute request ceiling (multipart overhead above the 25 MB video cap). */
const MAX_UPLOAD_REQUEST_BYTES = 32 * 1024 * 1024;

/**
 * Bounded authenticated server upload for private source-media copies.
 * Session-scoped: the workspace comes from the session cookie, the creator
 * must exist in it, and the storage path is server-generated - the browser
 * supplies only bytes, a declared type, an optional title, and a creator id.
 * No Cloudinary secret ever reaches the browser; validation, hashing, and
 * restricted-delivery storage all happen server-side.
 */
export async function POST(request: NextRequest) {
  try {
    await requireCurrentSession();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    throw error;
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_UPLOAD_REQUEST_BYTES) {
    return NextResponse.json(
      { error: "Upload is too large - images up to 10 MB and videos up to 25 MB can be uploaded." },
      { status: 400 }
    );
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Could not read the uploaded file - try again." }, { status: 400 });
  }
  const file = form.get("file");
  const creatorId = form.get("creatorId");
  const title = form.get("title");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Choose a file to upload." }, { status: 400 });
  }
  try {
    const media = await registerUploadedSourceMedia({
      creatorId: typeof creatorId === "string" ? creatorId : "",
      title: typeof title === "string" ? title : "",
      bytes: new Uint8Array(await file.arrayBuffer()),
      mimeType: file.type,
      filename: file.name
    });
    return NextResponse.json({ media });
  } catch (e) {
    logDkgError("media-upload", e);
    const safe = sanitizeDkgError(e, "workspace");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
