import { useState } from "react";
import { apiPost } from "@/lib/api";
import { newRunKey } from "@/lib/idempotency-key";
import { useLongAction } from "@/lib/use-long-action";
import { useInvalidateWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import { classifyReceiptForAnchor, type Campaign, type ReceiptPublishResult } from "@/server/types";

/**
 * The review mutation cluster: approve, verification refresh, republish,
 * regenerate, variations, and storage retry. These six share one error /
 * notice channel, one snapshot invalidation, and one refresh-after-mutate
 * contract, so they move together - the parent keeps selection and
 * disclosure state only (lightbox index, technical toggle). No business
 * policy lives here: every gate is re-checked server-side; this only
 * surfaces honest working/slow/timeout copy per action.
 */
export function useReviewActions(campaign: Campaign, onChanged: () => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Approval records proof through the ledger path, so it can legitimately
  // outlast the default 30s browser budget even though the server flips the
  // status fast and publishes detached. 120s + slow status + refresh-first
  // recovery: a client timeout must never read as "approval failed".
  const approval = useLongAction({
    working: "Recording approval…",
    slow: "Still recording the approval. Please keep this page open - proof services can take a little longer.",
    timedOut:
      "Recording is taking longer than expected. Refresh this page once before retrying - the approval may already have completed."
  });
  const [approvedUal, setApprovedUal] = useState<string | null>(campaign.campaignUAL ?? null);
  const [republishing, setRepublishing] = useState(false);
  const [republishMsg, setRepublishMsg] = useState<string | null>(null);
  const [republishProgress, setRepublishProgress] = useState<string | null>(null);
  const [retryingStorage, setRetryingStorage] = useState(false);
  const [storageMsg, setStorageMsg] = useState<string | null>(null);
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();
  const [refreshing, setRefreshing] = useState(false);
  const [regenFor, setRegenFor] = useState<string | null>(null);
  // Explicit variations: confirm-then-start per completed image. The dialog
  // states the spend before anything is dispatched; the original is untouched.
  const [varyConfirm, setVaryConfirm] = useState<string | null>(null);
  const [varyFor, setVaryFor] = useState<string | null>(null);

  async function approve() {
    if (approval.busy) return;
    setError(null);
    setNotice(null);
    const result = await approval.execute(() =>
      apiPost<{ approved: boolean; campaignUAL?: string; verificationRef?: string | null; verificationWarning?: string | null }>(
        `/api/campaigns/${campaign.id}/approve`,
        {},
        undefined,
        approval.timeoutMs
      )
    );
    if (!result.ok || !result.value) {
      // No auto-retry: the approval may already have completed server-side.
      if (result.message) setError(result.message);
      return;
    }
    const j = result.value;
    setApprovedUal(j.campaignUAL ?? null);
    if (j.verificationWarning) setNotice(j.verificationWarning);
    invalidateSnapshot();
    await onChanged();
  }

  async function refreshVerification() {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    setNotice(null);
    try {
      // Verification refresh publishes to the proof ledger like approval
      // and republish, so it gets the same extended budget instead of the
      // default 30s - a timeout retry safely mints another versioned
      // snapshot (append-only, never destructive), and the generic timeout
      // copy already says the server may still be working. Duplicate clicks
      // are disabled while refreshing.
      const j = await apiPost<{ verificationRef: string; created: boolean }>(`/api/campaigns/${campaign.id}/refresh-verification`, {}, undefined, 120000);
      setNotice(
        j.created
          ? "Verification link created from this approval's real data - share it from any output below."
          : "Verification link refreshed from this approval's real data."
      );
      invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refreshing the verification link failed.");
    } finally {
      setRefreshing(false);
    }
  }

  /**
   * Anchor eligible receipts one at a time so progress stays honest
   * ("Publishing 2 of 4 records…"). Each receipt persists its own
   * publishing -> anchored | failed state server-side, so a refresh or a
   * per-step timeout surfaces the durable outcome instead of resetting it.
   * Already-anchored, private, non-durable, and in-flight records are never
   * retried here - the server re-classifies every id defensively anyway.
   */
  async function republishPending() {
    if (republishing) return;
    const targets = campaign.receipts.filter((r) => classifyReceiptForAnchor(r) === "eligible");
    if (targets.length === 0) {
      setRepublishMsg("Nothing to publish - records are already published, private, not yet stored, or being published.");
      return;
    }
    setRepublishing(true);
    setRepublishMsg(null);
    setRepublishProgress(null);
    setError(null);
    const outcomes: ReceiptPublishResult[] = [];
    let unknown = 0;
    try {
      // Verifiable Memory finalization waits on-chain work: budget five
      // minutes per record. A step timeout does not stop the remaining
      // records - the timed-out record keeps finalizing server-side and the
      // refresh below shows its persisted outcome.
      for (let i = 0; i < targets.length; i += 1) {
        setRepublishProgress(`Publishing ${i + 1} of ${targets.length} records…`);
        try {
          const j = await apiPost<{ results: ReceiptPublishResult[] }>(
            `/api/campaigns/${campaign.id}/republish`,
            { receiptIds: [targets[i].id] },
            undefined,
            300000
          );
          outcomes.push(...(j.results ?? []));
        } catch (e) {
          unknown += 1;
          outcomes.push({
            receiptId: targets[i].id,
            status: "failed",
            reason: e instanceof Error ? e.message : "Request failed."
          });
        }
      }
      const anchored = outcomes.filter((o) => o.status === "anchored").length;
      const failed = outcomes.filter((o) => o.status === "failed").length;
      const parts: string[] = [];
      if (anchored > 0) parts.push(`${anchored} record${anchored === 1 ? "" : "s"} published to the proof ledger.`);
      if (failed > 0) parts.push(`${failed} record${failed === 1 ? "" : "s"} could not be published. Retry failed records.`);
      if (unknown > 0) parts.push(`${unknown} step${unknown === 1 ? "" : "s"} timed out - the server may still finish; refresh shows the persisted result.`);
      setRepublishMsg(parts.length > 0 ? parts.join(" ") : "Nothing new published.");
      invalidateSnapshot();
      await onChanged();
    } finally {
      setRepublishing(false);
      setRepublishProgress(null);
    }
  }

  /**
   * Explicit manual regenerate for an aspect-mismatched output. Deliberately
   * a visible paid action (same idempotent produce path as the plan):
   * mismatches never auto-retry, and the click itself is the consent.
   */
  async function regenerate(receiptId: string) {
    if (regenFor) return;
    const receipt = campaign.receipts.find((r) => r.id === receiptId);
    const job = receipt ? campaign.jobs.find((j) => j.id === receipt.jobId) : undefined;
    if (!receipt || !job) return;
    setRegenFor(receiptId);
    setError(null);
    try {
      await apiPost(`/api/campaigns/${campaign.id}/produce`, {
        stageIds: [job.stageId],
        idempotencyKey: newRunKey("regen")
      });
      invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Regeneration failed to start. Nothing was spent.");
    } finally {
      setRegenFor(null);
    }
  }

  /**
   * Explicit "Create variations": 2 additional image assets derived from one
   * selected completed output, each its own paid run. Confirm dialog states
   * the spend first; the server re-verifies eligibility (completed image,
   * live rights) before dispatching anything.
   */
  async function createVariations(receiptId: string) {
    if (varyFor) return;
    setVaryConfirm(null);
    setVaryFor(receiptId);
    setError(null);
    try {
      await apiPost(`/api/campaigns/${campaign.id}/variations`, { receiptId, count: 2 }, undefined, 120000);
      setNotice("Variations started - 2 additional assets are rendering from the selected output. The original is untouched.");
      invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Variations failed to start. Nothing was spent.");
    } finally {
      setVaryFor(null);
    }
  }

  async function retryStorage() {
    if (retryingStorage) return;
    setRetryingStorage(true);
    setStorageMsg(null);
    setError(null);
    try {
      // Cloudinary imports run ~35s per asset - budget three minutes.
      const j = await apiPost<{ finalized: number; legacyStored?: number; message: string }>(
        `/api/campaigns/${campaign.id}/retry-storage`,
        {},
        undefined,
        180000
      );
      setStorageMsg(j.message);
      invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Storage retry failed - the provider result is intact; try again in a moment.");
    } finally {
      setRetryingStorage(false);
    }
  }

  return {
    error,
    notice,
    approval,
    approvedUal,
    republishing,
    republishMsg,
    republishProgress,
    retryingStorage,
    storageMsg,
    refreshing,
    regenFor,
    varyFor,
    varyConfirm,
    setVaryConfirm,
    approve,
    refreshVerification,
    republishPending,
    regenerate,
    createVariations,
    retryStorage
  };
}
