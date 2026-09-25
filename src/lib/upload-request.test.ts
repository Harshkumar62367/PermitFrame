import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SourceMedia } from "@/server/types";
import { UploadCancelledError } from "./upload-progress";
import { postUpload, type UploadHooks } from "./upload-request";

/**
 * postUpload settlement: exactly-once across abort/error/timeout/load
 * races, typed cancellation carrying the abort-time phase, and unchanged
 * success behavior. A scripted XMLHttpRequest fake stands in for the
 * browser - no network, no DOM.
 */

type Handler = () => void;

class FakeXHR {
  openCalled: string[] = [];
  sent: unknown[] = [];
  aborted = 0;
  timeout = 0;
  status = 0;
  responseText = "";
  upload: { onprogress: Handler | null; onload: Handler | null } = { onprogress: null, onload: null };
  onabort: Handler | null = null;
  onload: Handler | null = null;
  onerror: Handler | null = null;
  ontimeout: Handler | null = null;

  open(method: string) {
    this.openCalled.push(method);
  }
  send(body: unknown) {
    this.sent.push(body);
  }
  abort() {
    this.aborted += 1;
    this.onabort?.();
  }
  json(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

const MEDIA = { id: "media_1", title: "t" } as SourceMedia;

function hooks(over: Partial<UploadHooks> = {}) {
  const seen = { progress: [] as unknown[], sent: 0, tracked: [] as unknown[] };
  const base: UploadHooks = {
    onProgress: (p) => {
      seen.progress.push(p);
    },
    onSent: () => {
      seen.sent += 1;
    },
    track: (xhr) => {
      seen.tracked.push(xhr);
    },
    phase: () => "uploading"
  };
  return { ...base, ...over, seen };
}

function withFakeXHR(run: (instances: FakeXHR[]) => Promise<void>): Promise<void> {
  const instances: FakeXHR[] = [];
  const real = (globalThis as Record<string, unknown>).XMLHttpRequest;
  (globalThis as Record<string, unknown>).XMLHttpRequest = class extends FakeXHR {
    constructor() {
      super();
      instances.push(this);
    }
  };
  return run(instances).finally(() => {
    (globalThis as Record<string, unknown>).XMLHttpRequest = real;
  });
}

describe("postUpload settlement", () => {
  it("abort settles exactly once even when every other handler fires", async () => {
    await withFakeXHR(async (instances) => {
      const h = hooks({ phase: () => "processing" });
      const pending = postUpload(new FormData(), h);
      const xhr = instances[0];
      const outcome = await Promise.allSettled([
        pending,
        (async () => {
          xhr.abort();
          // Late/duplicate events after abort must not re-settle.
          xhr.onload?.();
          xhr.onerror?.();
          xhr.ontimeout?.();
          xhr.abort();
        })()
      ]);
      assert.equal(xhr.aborted, 2, "abort itself may repeat; settlement must not");
      const first = outcome[0];
      assert.equal(first.status, "rejected");
      if (first.status !== "rejected") return;
      assert.ok(first.reason instanceof UploadCancelledError);
      assert.equal((first.reason as UploadCancelledError).phase, "processing");
    });
  });

  it("abort during byte transfer reports the uploading phase", async () => {
    await withFakeXHR(async (instances) => {
      const pending = postUpload(new FormData(), hooks());
      instances[0].abort();
      const reason = await pending.then(
        () => assert.fail("must reject"),
        (e: unknown) => e
      );
      assert.ok(reason instanceof UploadCancelledError);
      assert.equal((reason as UploadCancelledError).phase, "uploading");
    });
  });

  it("successful uploads resolve unchanged and never report cancellation", async () => {
    await withFakeXHR(async (instances) => {
      const h = hooks();
      const pending = postUpload(new FormData(), h);
      instances[0].json(200, { media: MEDIA });
      assert.deepEqual(await pending, { media: MEDIA });
      assert.equal(h.seen.sent, 0);
    });
  });

  it("server errors reject with status and stay non-cancelled", async () => {
    await withFakeXHR(async (instances) => {
      const pending = postUpload(new FormData(), hooks());
      instances[0].json(400, { error: "Choose a file to upload." });
      const reason = await pending.then(
        () => assert.fail("must reject"),
        (e: unknown) => e
      );
      assert.ok(!(reason instanceof UploadCancelledError));
      assert.equal((reason as Error).message, "Choose a file to upload.");
      assert.equal((reason as Error & { status: number }).status, 400);
    });
  });
});
