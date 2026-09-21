import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ApiError, apiGet } from "./api";

/** api() error classification. No network — fetch is stubbed per test. */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(fn: () => Promise<Response>): void {
  globalThis.fetch = fn as typeof fetch;
}

function timeoutError(): DOMException {
  // What AbortSignal.timeout() rejects with in modern browsers.
  return new DOMException("The operation timed out.", "TimeoutError");
}

describe("api error classification", () => {
  it("reports our own timeout budget honestly, never as a network failure", async () => {
    stubFetch(async () => {
      // Simulate the real path: the budget signal fires first, then fetch
      // rejects with the TimeoutError the platform produces on abort.
      await new Promise((r) => setTimeout(r, 60));
      throw timeoutError();
    });
    const err = await apiGet("/api/x", undefined, 50).then(
      () => assert.fail("must throw"),
      (e: Error) => e
    );
    assert.ok(err instanceof ApiError);
    assert.match(err.message, /timed out/);
    assert.ok(!err.message.includes("Network request failed"));
  });

  it("reports genuine network failures as network failures", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    const err = await apiGet("/api/x").then(
      () => assert.fail("must throw"),
      (e: Error) => e
    );
    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).status, 0);
    assert.match(err.message, /Network request failed/);
  });

  it("surfaces server error bodies with their status", async () => {
    stubFetch(() => Promise.resolve(new Response(JSON.stringify({ error: "Nope." }), { status: 400 })));
    const err = await apiGet("/api/x").then(
      () => assert.fail("must throw"),
      (e: Error) => e
    );
    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).status, 400);
    assert.equal(err.message, "Nope.");
  });
});
