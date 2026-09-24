import type { ConsentInviteStatus, Database, SourceMedia } from "./types";
import { temporarySourceDownloadUrl } from "./cloudinary";
import { previewMimeForFormat } from "./source-upload";
import { consentLifecycle } from "./consent-validation";

/**
 * Workspace-only preview serving for uploaded source images.
 *
 * Data flow: the browser requests same-origin
 * `/api/media/<id>/preview` with its session cookie. The route loads ONLY
 * the session workspace database, resolves the row below, mints the
 * Cloudinary temporary download URL server-side, fetches the bytes
 * server-to-server, and streams them back as the response body. The
 * browser never sees a redirect, a Cloudinary hostname, a public id, a
 * signature, the storage object, or the byte hash - only opaque
 * same-origin image bytes with `Cache-Control: private, no-store`.
 * Video uploads stay non-preview tiles (no Range support this iteration).
 */

export const PREVIEW_NOT_FOUND = "Source media not found.";
export const PREVIEW_UNAVAILABLE = "Preview is temporarily unavailable - try again shortly.";

export interface PreviewDeps {
  downloadUrl?: (input: {
    publicId: string;
    format: string;
    resourceType: "image" | "video";
    expiresInSeconds?: number;
  }) => string;
  fetchImpl?: typeof fetch;
}

export type PreviewResult =
  | { status: 200; response: Response }
  | { status: 404; error: string }
  | { status: 503; error: string };

/**
 * Resolve a previewable row: uploaded images with complete storage only.
 * Unknown ids, foreign rows (the caller passes only the session workspace
 * database, so cross-workspace ids simply miss), URL registrations,
 * videos, and malformed upload rows all resolve to null - the route
 * answers every one of them with the same 404, revealing nothing about
 * which condition occurred. Pure and unit-tested.
 */
export function resolvePreviewMedia(db: Database, mediaId: unknown): SourceMedia | null {
  if (typeof mediaId !== "string" || mediaId.length === 0) return null;
  const media = db.sourceMedia.find((m) => m.id === mediaId);
  if (!media || media.source !== "upload" || media.type !== "image") return null;
  if (!media.storage?.publicId || !media.storage.format) return null;
  return media;
}

/**
 * Resolve an image preview through a consent-link capability. The opaque
 * index is meaningful only within this one invitation and is converted to
 * the real source-media id server-side. Only active review links (pending
 * or viewed) may display it; approved, declined, cancelled, and expired
 * links cannot be used as a lasting media viewer.
 */
export function resolveConsentPreviewMediaId(
  db: Database,
  invite: { status: ConsentInviteStatus; linkExpiresAt?: string; draft: { sourceMediaIds?: string[] } },
  previewIndex: unknown,
  today: string = new Date().toISOString().slice(0, 10)
): string | null {
  const lifecycle = consentLifecycle(invite, today);
  if (lifecycle !== "pending" && lifecycle !== "viewed") return null;
  if (typeof previewIndex !== "number" || !Number.isSafeInteger(previewIndex) || previewIndex < 0) return null;
  const mediaId = invite.draft.sourceMediaIds?.[previewIndex];
  return resolvePreviewMedia(db, mediaId)?.id ?? null;
}

/**
 * Serve one preview: stream upstream bytes through without buffering the
 * file in memory (the ReadableStream passes straight into the response).
 * Upstream failures, non-image payloads, and thrown errors all collapse
 * to static safe messages - raw provider text (which could echo the
 * temporary URL) never reaches logs, errors, or the client.
 */
export async function serveSourcePreview(
  db: Database,
  mediaId: unknown,
  deps: PreviewDeps = {}
): Promise<PreviewResult> {
  const media = resolvePreviewMedia(db, mediaId);
  const storage = media?.storage;
  const mime = previewMimeForFormat(storage?.format);
  if (!media || !storage || !mime) return { status: 404, error: PREVIEW_NOT_FOUND };
  const download = deps.downloadUrl ?? temporarySourceDownloadUrl;
  const fetchImpl = deps.fetchImpl ?? fetch;
  let upstream: Response;
  try {
    const url = download({ publicId: storage.publicId, format: storage.format, resourceType: "image" });
    upstream = await fetchImpl(url);
  } catch {
    return { status: 503, error: PREVIEW_UNAVAILABLE };
  }
  if (!upstream.ok || !upstream.body) return { status: 503, error: PREVIEW_UNAVAILABLE };
  const upstreamType = upstream.headers.get("content-type") ?? "";
  if (!upstreamType.toLowerCase().startsWith("image/")) return { status: 503, error: PREVIEW_UNAVAILABLE };
  return {
    status: 200,
    response: new Response(upstream.body, {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff"
      }
    })
  };
}
