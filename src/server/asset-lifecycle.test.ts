import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  hasSharableReceipt,
  isActiveJobStatus,
  isDeliveredJobStatus,
  migrateJobStatus,
  type JobStatus
} from "./types";
import { deliverableState } from "@/components/studio/studio-model";
import type { ProductionJob } from "./types";

/**
 * Async-delivery lifecycle tests (pure state machine - no network, no spend):
 * queued → generating → preview_ready → storage_pending → ready_to_share,
 * with storage_retry_needed as the honest failure branch.
 */

function job(status: JobStatus): ProductionJob {
  return { id: "job_1", campaignId: "cmp_1", stageId: "keyframe", kind: "text-to-image", capability: "flux-schnell", prompt: "p", status, startedAt: "t" };
}

describe("lifecycle transitions", () => {
  it("migrates legacy rows without guessing unknowns", () => {
    assert.equal(migrateJobStatus("running"), "generating");
    assert.equal(migrateJobStatus("succeeded"), "ready_to_share");
    for (const s of ["queued", "generating", "preview_ready", "storage_pending", "storage_retry_needed", "ready_to_share", "failed"]) {
      assert.equal(migrateJobStatus(s), s);
    }
    assert.throws(() => migrateJobStatus("archived-ish"), /manual review/);
  });

  it("active means still-moving; only ready_to_share is delivered", () => {
    for (const s of ["queued", "generating", "preview_ready", "storage_pending"] as JobStatus[]) {
      assert.equal(isActiveJobStatus(s), true, `${s} must poll`);
      assert.equal(isDeliveredJobStatus(s), false, `${s} must not deliver`);
    }
    assert.equal(isActiveJobStatus("storage_retry_needed"), false, "retry waits for the user");
    assert.equal(isActiveJobStatus("ready_to_share"), false);
    assert.equal(isActiveJobStatus("failed"), false);
    assert.equal(isDeliveredJobStatus("ready_to_share"), true);
  });

  it("deliverables aggregate the new states honestly", () => {
    const ids = ["keyframe"];
    assert.equal(deliverableState([job("preview_ready")], ids), "running");
    assert.equal(deliverableState([job("storage_pending")], ids), "running");
    assert.equal(deliverableState([job("storage_retry_needed")], ids), "failed");
    assert.equal(deliverableState([job("ready_to_share")], ids), "done");
    assert.equal(deliverableState([job("ready_to_share"), job("storage_retry_needed")], ["keyframe", "motion"]), "failed");
  });
});

describe("delivery gates", () => {
  it("previews never share; only stored receipts do", () => {
    // No receipt exists at preview - nothing to gate on.
    assert.equal([].some(hasSharableReceipt), false);
    assert.equal(hasSharableReceipt({ storageStatus: "stored" }), true);
    assert.equal(hasSharableReceipt({}), false, "legacy provider-hosted outputs stay private until stored");
    assert.equal(hasSharableReceipt({ storageStatus: "pending" }), false);
    assert.equal(hasSharableReceipt({ storageStatus: "failed" }), false);
  });

  it("proof requires a sharable receipt, never a bare preview", () => {
    const previewOnly: { storageStatus?: "pending" | "stored" | "failed" }[] = [];
    const delivered = [{ storageStatus: "stored" as const }];
    const legacy = [{}];
    assert.equal(previewOnly.some(hasSharableReceipt), false);
    assert.equal(delivered.some(hasSharableReceipt), true);
    assert.equal(legacy.some(hasSharableReceipt), false, "legacy must be stored first");
  });
});

describe("url fingerprints are never content evidence", () => {
  it("proof payloads carry no outputHash predicate", () => {
    const schemas = fs.readFileSync(path.join(process.cwd(), "src", "server", "dkg", "schemas.ts"), "utf8");
    assert.ok(!schemas.includes("pf:outputHash"), "receipt KA must not publish a URL fingerprint as outputHash");
    assert.ok(schemas.includes("pf:providerUrlFingerprint"), "correlation uses the honest predicate name");
  });

  it("snapshots and bundles emit fingerprints, never outputHash keys", () => {
    for (const file of ["src/server/verification-snapshot.ts", "src/app/api/campaigns/[id]/bundle/route.ts"]) {
      const src = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      assert.ok(!src.includes("outputHash:"), `${file} must not emit outputHash keys`);
    }
  });

  it("no content-hash language survives in proof or studio copy", () => {
    const banned = ["contentHash", "assetHash", "pf:outputHash", "outputHash:", "immutable content", "immutable evidence", "byte-level verification", "content hash", "checksum"];
    const files = [
      "src/server/dkg/schemas.ts",
      "src/server/verification-snapshot.ts",
      "src/server/livepeer/pipeline.ts",
      "src/app/api/campaigns/[id]/bundle/route.ts",
      "src/components/studio/review-section.tsx",
      "src/components/studio/queue-panel.tsx",
      "src/app/(app)/media/page.tsx"
    ];
    for (const file of files) {
      const src = fs.readFileSync(path.join(process.cwd(), file), "utf8").toLowerCase();
      for (const phrase of banned) {
        assert.ok(!src.includes(phrase.toLowerCase()), `${file} must not present fingerprints as ${phrase}`);
      }
    }
  });
});
