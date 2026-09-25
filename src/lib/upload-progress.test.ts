import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyUploadError,
  progressForTransmittedBytes,
  shouldReconcileAfterUploadFailure,
  UploadCancelledError
} from "./upload-progress";

/**
 * Honest upload progress: the browser counts request bytes only, so the
 * percentage must never reach 100 before the server answers, and a fully
 * transmitted request moves to an indeterminate processing state (server
 * delivery, hashing, and recording still run). Pure and unit-tested.
 */
describe("progressForTransmittedBytes", () => {
  it("reports uploading percentages capped at 99", () => {
    assert.deepEqual(progressForTransmittedBytes(0, 100), { phase: "uploading", pct: 0 });
    assert.deepEqual(progressForTransmittedBytes(50, 100), { phase: "uploading", pct: 50 });
    assert.deepEqual(progressForTransmittedBytes(99, 100), { phase: "uploading", pct: 99 });
    assert.deepEqual(progressForTransmittedBytes(999, 1000), { phase: "uploading", pct: 99 });
  });

  it("never reports 100 from transmitted bytes alone", () => {
    for (const [loaded, total] of [[100, 100], [1000, 1000], [5, 5]] as const) {
      const p = progressForTransmittedBytes(loaded, total);
      assert.equal(p.phase, "processing");
      assert.equal(p.pct, null);
    }
  });

  it("handles unmeasurable and degenerate input without completing", () => {
    assert.deepEqual(progressForTransmittedBytes(0, NaN).phase, "uploading");
    assert.deepEqual(progressForTransmittedBytes(10, 0), { phase: "uploading", pct: 0 });
    assert.deepEqual(progressForTransmittedBytes(-5, 100), { phase: "uploading", pct: 0 });
  });
});

describe("shouldReconcileAfterUploadFailure", () => {
  it("reconciles on unknown outcomes only", () => {
    assert.equal(shouldReconcileAfterUploadFailure(0), true);
    assert.equal(shouldReconcileAfterUploadFailure(500), true);
    assert.equal(shouldReconcileAfterUploadFailure(503), true);
    assert.equal(shouldReconcileAfterUploadFailure(400), false);
    assert.equal(shouldReconcileAfterUploadFailure(401), false);
    assert.equal(shouldReconcileAfterUploadFailure(404), false);
  });
});

describe("classifyUploadError", () => {
  it("routes cancellation away from the generic failure path", () => {
    assert.deepEqual(classifyUploadError(new UploadCancelledError("uploading")), {
      kind: "cancelled",
      phase: "uploading"
    });
    assert.deepEqual(classifyUploadError(new UploadCancelledError("processing")), {
      kind: "cancelled",
      phase: "processing"
    });
  });

  it("passes failures through with their status", () => {
    const err = new Error("Choose a file to upload.") as Error & { status: number };
    err.status = 400;
    assert.deepEqual(classifyUploadError(err), { kind: "failed", status: 400 });
    assert.deepEqual(classifyUploadError(new Error("boom")), { kind: "failed", status: -1 });
    assert.deepEqual(classifyUploadError("string failure"), { kind: "failed", status: -1 });
  });
});
