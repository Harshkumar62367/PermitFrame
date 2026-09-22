import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "./api";
import {
  LONG_ACTION_SLOW_AFTER_MS,
  createSlowTimer,
  isClientTimeout,
  longActionErrorMessage
} from "./long-action";

/** Long-action helper: timeout classification, recovery copy, slow timer. No network, no DKG. */

describe("long-action helper", () => {
  it("reveals the slow status after 5 seconds", () => {
    assert.equal(LONG_ACTION_SLOW_AFTER_MS, 5_000);
  });

  it("treats only our own timeout budget (status 0) as a client timeout", () => {
    assert.equal(isClientTimeout(new ApiError("/api/x", 0, "timed out")), true);
    assert.equal(isClientTimeout(new ApiError("/api/x", 503, "unavailable")), false);
    assert.equal(isClientTimeout(new Error("boom")), false);
    assert.equal(isClientTimeout(null), false);
  });

  it("maps a client timeout to refresh-first recovery copy, never 'failed'", () => {
    const message = longActionErrorMessage(
      new ApiError("/api/x", 0, "Request timed out after 120s"),
      "Refresh this page once before retrying - the work may already have completed.",
      "fallback"
    );
    assert.equal(message, "Refresh this page once before retrying - the work may already have completed.");
    assert.ok(!message.toLowerCase().includes("fail"));
  });

  it("keeps honest server error messages untouched", () => {
    const server = new ApiError("/api/x", 400, "Blocked campaigns cannot be approved");
    assert.equal(longActionErrorMessage(server, "timed-out copy", "fallback"), "Blocked campaigns cannot be approved");
    assert.equal(longActionErrorMessage(new Error("Network request failed"), "timed-out copy", "fallback"), "Network request failed");
  });

  it("falls back without inventing detail for non-Error throws", () => {
    assert.equal(longActionErrorMessage("weird", "timed-out copy", "fallback copy"), "fallback copy");
  });

  it("fires the slow callback after the delay", async () => {
    let fired = false;
    const cancel = createSlowTimer(() => {
      fired = true;
    }, 10);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(fired, true);
    cancel();
  });

  it("cancel prevents a stale slow callback from firing", async () => {
    let fired = false;
    const cancel = createSlowTimer(() => {
      fired = true;
    }, 10);
    cancel();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(fired, false);
  });
});
