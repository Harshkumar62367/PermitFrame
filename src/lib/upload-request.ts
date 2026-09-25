import type { SourceMedia } from "@/server/types";
import { progressForTransmittedBytes, UploadCancelledError, type UploadProgress } from "./upload-progress";

export interface UploadHooks {
  onProgress: (p: UploadProgress) => void;
  /** Fired when request bytes are fully transmitted (server work continues). */
  onSent: () => void;
  /** Receives the live XHR so the caller can abort it. */
  track: (xhr: XMLHttpRequest) => void;
  /** Transfer phase at abort time (bytes may still be leaving). */
  phase: () => "uploading" | "processing";
}

/**
 * Same-origin authenticated media upload with honest two-phase progress.
 * Settles exactly once: a settled flag serializes onabort/onerror/
 * ontimeout/onload so no race can resolve and reject (or reject twice) -
 * in particular, aborting an already-settled request is a silent no-op and
 * can never surface a false failure or an unhandled rejection.
 */
export function postUpload(formData: FormData, hooks: UploadHooks): Promise<{ media: SourceMedia }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const fail = (message: string, status: number) => {
      const error = new Error(message) as Error & { status: number };
      error.status = status;
      reject(error);
    };
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/media/upload");
    // 25 MB over slow uplinks plus server-side delivery, hashing, and
    // recording can legitimately take minutes - the phase copy (not a
    // longer spinner alone) is what keeps this honest.
    xhr.timeout = 300000;
    xhr.upload.onprogress = (e) => {
      hooks.onProgress(progressForTransmittedBytes(e.loaded, e.lengthComputable ? e.total : NaN));
    };
    // Request bytes fully transmitted: the server may now work for a
    // while (delivery, hashing, registering) with nothing more to count.
    xhr.upload.onload = () => hooks.onSent();
    xhr.onabort = () => settle(() => reject(new UploadCancelledError(hooks.phase())));
    xhr.onload = () =>
      settle(() => {
        let body: { media?: SourceMedia; error?: string } = {};
        try {
          body = JSON.parse(xhr.responseText) as { media?: SourceMedia; error?: string };
        } catch {
          fail("Upload failed - the server response was unreadable. Your file was not registered.", xhr.status);
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300 && body.media) resolve({ media: body.media });
        else fail(body.error || `Upload failed (status ${xhr.status}). Your file was not registered.`, xhr.status);
      });
    xhr.onerror = () => settle(() => fail("Network request failed - check your connection and retry.", 0));
    xhr.ontimeout = () => settle(() => fail("Upload timed out after 5 minutes - the server may still be finishing.", 0));
    hooks.track(xhr);
    xhr.send(formData);
  });
}
