import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadDb, sha256 } from "@/server/store";
import { findCampaign } from "@/server/platform";
import { finalizeStoredJob, storeLegacyOutput } from "@/server/livepeer/pipeline";
import { hasSharableReceipt } from "@/server/types";
import { ASSET_MAX_ATTEMPTS, retryCampaignAssets } from "@/server/asset-store";

export const dynamic = "force-dynamic";

/**
 * Bounded retry for durable-storage persistence. Picks up jobs stuck in
 * storage_pending/storage_retry_needed, re-attempts the Cloudinary import
 * within the attempt budget, and delivers newly stored assets. Also handles
 * "Store securely" for provider-hosted legacy outputs (no regeneration, no
 * duplicate assets). Never fabricates: jobs that remain unstored keep their
 * provider preview with an honest status.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let workspaceId: string;
  try {
    ({ workspaceId } = await requireCurrentSession());
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    throw error;
  }
  const campaign = await findCampaign(id).catch(() => null);
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  const { retried, stored } = await retryCampaignAssets(workspaceId, id, async (jobId) => {
    const db = await loadDb();
    const job = db.campaigns.find((c) => c.id === id)?.jobs.find((j) => j.id === jobId) ?? null;
    if (!job) return null;
    return { job, promptHash: sha256(job.prompt) };
  });
  let finalized = 0;
  if (stored > 0) {
    const db = await loadDb();
    const jobs = db.campaigns.find((c) => c.id === id)?.jobs.filter((j) => j.status === "storage_pending" || j.status === "storage_retry_needed") ?? [];
    for (const job of jobs) {
      if ((await finalizeStoredJob(workspaceId, id, job.id).catch(() => ({ finalized: false }))).finalized) {
        finalized += 1;
      }
    }
  }
  // "Store securely" for provider-hosted legacy outputs: same idempotent
  // flow, no regeneration. Expired provider links fail honestly.
  let legacyStored = 0;
  let legacyMessage: string | null = null;
  {
    const db = await loadDb();
    const legacyJobs = db.campaigns.find((c) => c.id === id)?.jobs.filter((j) => {
      if (j.status !== "ready_to_share") return false;
      const receipt = db.campaigns.find((c) => c.id === id)?.receipts.find((r) => r.jobId === j.id);
      return receipt !== undefined && !hasSharableReceipt(receipt);
    }) ?? [];
    for (const job of legacyJobs) {
      const out = await storeLegacyOutput(workspaceId, id, job.id).catch(() => ({ stored: false as const, message: "Store securely failed - try again in a moment." }));
      if (out.stored) legacyStored += 1;
      else legacyMessage = out.message;
    }
  }
  return NextResponse.json({
    retried,
    stored,
    finalized,
    legacyStored,
    maxAttempts: ASSET_MAX_ATTEMPTS,
    message:
      finalized + legacyStored > 0
        ? `${finalized + legacyStored} asset${finalized + legacyStored === 1 ? "" : "s"} stored and delivered.`
        : legacyMessage ?? (retried > 0
          ? "Storage retry ran - assets that stored are delivered; the rest stay pending with their provider result."
          : "Nothing left to retry within the attempt budget.")
  });
}
