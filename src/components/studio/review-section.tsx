"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, ChevronDown, ChevronLeft, ChevronRight, Download, Maximize2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { preservationIndicator } from "@/lib/preservation";
import { campaignOutcome, OutcomeBadge } from "@/components/campaign-outcome";
import { apiPost } from "@/lib/api";
import { newRunKey } from "@/lib/idempotency-key";
import { describeActualSize } from "@/server/livepeer/aspect";
import { useLongAction } from "@/lib/use-long-action";
import { useInvalidateWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import { cn } from "@/lib/utils";
import type { Campaign } from "@/server/types";
import { hasSharableReceipt, isActiveJobStatus } from "@/server/types";
import { downloadHrefFor, blockExplorerNftUrl } from "@/lib/proof-links";

interface ReviewSectionProps {
  campaign: Campaign;
  onChanged: () => Promise<void>;
}
/**
 * Review & deliver: real outputs with per-asset evidence, the proof bundle,
 * and the approve action. Approval stays gated server-side (needs succeeded
 * outputs, never when blocked) - this section only surfaces that gate.
 */
export function ReviewSection({ campaign, onChanged }: ReviewSectionProps) {
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
  const [retryingStorage, setRetryingStorage] = useState(false);
  const [storageMsg, setStorageMsg] = useState<string | null>(null);
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();

  const succeeded = campaign.jobs.filter((j) => j.status === "ready_to_share").length;
  const active = campaign.jobs.some((j) => isActiveJobStatus(j.status));
  const storagePending = campaign.jobs.filter((j) => j.status === "storage_pending");
  // Only durable outputs unlock share/download/proof. Provider-hosted legacy
  // outputs stay previewable until stored via the action below.
  const sharable = campaign.receipts.some((r) => hasSharableReceipt(r));
  const legacyHosted = campaign.receipts.filter((r) => !hasSharableReceipt(r));
  const pendingRecords = campaign.receipts.filter((r) => !r.ual);
  const outcome = campaignOutcome({
    status: campaign.status,
    decision: campaign.preflight?.decision ?? null,
    hasOutputs: campaign.receipts.length > 0,
    publicationStatus: campaign.publicationStatus,
    campaignUAL: campaign.campaignUAL
  });
  const [showTechnical, setShowTechnical] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [regenFor, setRegenFor] = useState<string | null>(null);
  // Explicit variations: confirm-then-start per completed image. The dialog
  // states the spend before anything is dispatched; the original is untouched.
  const [varyConfirm, setVaryConfirm] = useState<string | null>(null);
  const [varyFor, setVaryFor] = useState<string | null>(null);
  // Lightbox index into campaign.receipts (null = closed). Thumbnails are
  // uniform boxes, so the true aspect ratio is only visible here.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const lightboxReceipt = lightboxIndex !== null ? campaign.receipts[lightboxIndex] ?? null : null;

  useEffect(() => {
    if (lightboxIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxIndex(null);
      if (e.key === "ArrowRight") setLightboxIndex((i) => (i === null ? i : (i + 1) % campaign.receipts.length));
      if (e.key === "ArrowLeft") setLightboxIndex((i) => (i === null ? i : (i - 1 + campaign.receipts.length) % campaign.receipts.length));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxIndex, campaign.receipts.length]);
  const receiptRecords = campaign.receipts.filter((r) => r.ual);
  const campaignRecord = campaign.campaignUAL ?? approvedUal;
  const hasTechnicalRecords = receiptRecords.length > 0 || !!campaignRecord;

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
      const j = await apiPost<{ verificationRef: string; created: boolean }>(`/api/campaigns/${campaign.id}/refresh-verification`);
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

  async function republishPending() {
    if (republishing) return;
    setRepublishing(true);
    setRepublishMsg(null);
    setError(null);
    try {
      // Sequential ledger publishes can exceed the default 30s budget.
      const j = await apiPost<{ republished: string[] }>(`/api/campaigns/${campaign.id}/republish`, {}, undefined, 120000);
      setRepublishMsg(
        j.republished.length > 0
          ? `${j.republished.length} record${j.republished.length === 1 ? "" : "s"} published to the proof ledger.`
          : "Nothing new published - the ledger is unreachable or records are already published. Check Settings › Asset production, then retry."
      );
      invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Republish failed. The ledger may be offline - retry once it is back.");
    } finally {
      setRepublishing(false);
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

  return (
    <section aria-label="Review and deliver" className="rounded-2xl border border-border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold tracking-tight">Review & deliver</h3>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            {campaign.receipts.length === 0
              ? "No outputs yet - generated assets land here with their evidence."
              : `${campaign.receipts.length} output${campaign.receipts.length === 1 ? "" : "s"} · ${succeeded} stage${succeeded === 1 ? "" : "s"} succeeded`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {sharable && (
            <Button asChild variant="outline" size="sm" className="rounded-full" title="Download the offline evidence pack: brief, permission decision, per-stage costs and fingerprints, receipts, audit events. No prompts, no secrets - for client handoff, disputes, and archiving.">
              <a href={`/api/campaigns/${campaign.id}/bundle`} download>
                <Download className="h-3.5 w-3.5" /> Proof bundle
              </a>
            </Button>
          )}
          {campaign.status !== "approved" ? (
            <Button
              size="sm"
              onClick={() => void approve()}
              disabled={approval.busy || active || succeeded === 0 || !sharable}
              aria-busy={approval.busy}
              title={succeeded === 0 ? "Generate the pack first - there is nothing to approve yet" : active ? "Wait for production to finish before approving" : !sharable ? "Store outputs securely before approving - provider-hosted assets cannot be published as proof yet" : "Approve the pack - the campaign record publishes in the background"}
              className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
            >
              {approval.busy ? "Recording approval…" : "Approve pack"}
            </Button>
          ) : (
            <OutcomeBadge outcome={outcome} />
          )}
        </div>
      </div>

      {/* Pre-snapshot approvals have no public link yet: mint one from real data. */}
      {campaign.status === "approved" && !campaign.verificationRef && (
        <div className="mt-4 rounded-xl border border-dashed border-border p-4">
          <p className="text-[13px] font-medium">No public verification link yet</p>
          <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-muted-foreground">
            This pack was approved before public links existed. Create one now from this approval&apos;s real data -
            nothing is marked verified beyond what the record honestly carries.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refreshVerification()}
            disabled={refreshing || approval.busy}
            aria-busy={refreshing}
            className="mt-3 rounded-full"
          >
            {refreshing ? "Creating link…" : "Refresh verification link"}
          </Button>
        </div>
      )}

      {error && <p role="alert" className="mt-3 break-words text-[12.5px] text-rose-600 dark:text-rose-300">{error}</p>}
      {approval.busy && approval.status && (
        <p role="status" className="mt-3 break-words text-[12.5px] text-muted-foreground">{approval.status}</p>
      )}
      {notice && <p role="status" className="mt-3 break-words text-[12.5px] text-amber-700 dark:text-amber-300">{notice}</p>}

      {campaign.receipts.length > 0 ? (
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {campaign.receipts.map((r, i) => (
            <div key={r.id} className="group overflow-hidden rounded-xl bg-muted/60 ring-1 ring-border transition hover:ring-emerald-600/40">
              {r.mediaType === "image" ? (
                <button
                  type="button"
                  onClick={() => setLightboxIndex(i)}
                  title={`${r.label} — click to view full size`}
                  aria-label={`View ${r.label} full size`}
                  className="block w-full cursor-zoom-in focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={r.outputUrl} alt={r.label} loading="lazy" className="aspect-[3/4] w-full object-cover" />
                </button>
              ) : (
                <div className="relative">
                  <video
                    src={r.outputUrl}
                    controls
                    preload="metadata"
                    className="aspect-[3/4] w-full bg-black object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => setLightboxIndex(i)}
                    title={`${r.label} — click to view full size`}
                    aria-label={`View ${r.label} full size`}
                    className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-black/60 text-white opacity-0 transition hover:bg-black/80 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
                  >
                    <Maximize2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
              )}
              <div className="space-y-1 p-3">
                <p className="text-[12.5px] font-medium leading-tight">{r.label}</p>
                <p
                  className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground"
                  title={
                    r.actualCapability && r.actualCapability !== r.capability
                      ? `Planned ${r.requestedCapability ?? r.capability}, actually rendered with ${r.actualCapability}`
                      : `Rendered with ${r.capability}`
                  }
                >
                  {r.format}
                  {r.actualWidth !== undefined && r.actualHeight !== undefined && ` · ${r.actualWidth}×${r.actualHeight}`}
                  {" · "}{r.actualCapability ?? r.capability}
                </p>
                {(() => {
                  // What actually ran, not what was planned: compact pill,
                  // full sentence on hover. Legacy rows without preservation
                  // fields normalize to no claim and render nothing here.
                  const ind = preservationIndicator(r);
                  if (!ind.label) return null;
                  return (
                    <p className="text-[10.5px] font-medium text-muted-foreground" title={ind.detail}>
                      {ind.label}
                      {ind.fallbackUsed && <span className="text-amber-700 dark:text-amber-300"> · fallback used</span>}
                    </p>
                  );
                })()}
                {r.aspectVerdict === "mismatch" && r.actualWidth !== undefined && r.actualHeight !== undefined ? (
                  <p role="status" className="break-words text-[11px] font-medium leading-snug text-amber-700 dark:text-amber-300">
                    Needs review — requested {r.format}, received {describeActualSize(r.actualWidth, r.actualHeight)}.
                  </p>
                ) : (
                  <p className="text-[10.5px] text-muted-foreground" title={r.storageStatus === "stored" ? "Persisted to PermitFrame durable storage; the provider original stays on record" : "Provider-hosted legacy output - previewable, but not share-ready until stored securely"}>
                    {r.storageStatus === "stored" ? "Stored in PermitFrame" : r.storageStatus === "failed" ? "Storage failed" : "Provider-hosted legacy asset"}
                  </p>
                )}
                <div className="mt-1 flex flex-wrap gap-1.5">
                {r.aspectVerdict === "mismatch" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void regenerate(r.id)}
                    disabled={regenFor !== null || varyFor !== null || active}
                    aria-busy={regenFor === r.id}
                    title="Generate this stage again for the planned placement — a new paid run; nothing retries automatically"
                    className="h-7 rounded-full px-2.5 text-[11px]"
                  >
                    {regenFor === r.id ? "Regenerating…" : `Regenerate ${r.format}`}
                  </Button>
                )}
                {(() => {
                  // Explicit variations only from a completed stored image:
                  // the server re-verifies before dispatch. Cost is stated
                  // in the confirm dialog, never silently incurred.
                  const job = campaign.jobs.find((j) => j.id === r.jobId);
                  if (r.mediaType !== "image" || job?.status !== "ready_to_share") return null;
                  return (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setVaryConfirm(r.id)}
                      disabled={regenFor !== null || varyFor !== null || active}
                      aria-busy={varyFor === r.id}
                      title="Derive 2 additional image assets from this completed output as new paid runs - the original stays intact"
                      className="h-7 rounded-full px-2.5 text-[11px]"
                    >
                      <Sparkles className="h-3 w-3" aria-hidden />
                      {varyFor === r.id ? "Starting…" : "Create variations"}
                    </Button>
                  );
                })()}
                </div>
                <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-0.5">
                {campaign.verificationRef ? (
                  <Link href={`/verify/${campaign.verificationRef}#output-${r.id}`} className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-700 hover:underline dark:text-sky-300">
                    Verify <ArrowRight className="h-3 w-3" />
                  </Link>
                ) : (
                  <span className="text-[11px] text-muted-foreground" title="Approve the pack to publish its verification link">
                    Verify after approval
                  </span>
                )}
                {(() => {
                  const dl = downloadHrefFor(r.outputUrl, r.storageUrl);
                  return (
                    <a
                      href={dl.href}
                      target="_blank"
                      rel="noreferrer"
                      download={dl.attachment ? true : undefined}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      title={dl.attachment ? "Download the stored file" : "Open the original in a new tab to save it"}
                    >
                      <Download className="h-3 w-3" /> Download
                    </a>
                  );
                })()}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-5 rounded-xl border border-dashed border-border p-6 text-center">
          <p className="text-[13px] font-medium">No outputs to review yet</p>
          <p className="mx-auto mt-1 max-w-sm text-[12px] leading-relaxed text-muted-foreground">
            Generate the selected deliverables above. If generation produces nothing, the queue shows exactly which stage failed and why - nothing is faked.
          </p>
        </div>
      )}

      <ConfirmDialog
        open={varyConfirm !== null}
        title="Create 2 variations?"
        consequence="This derives 2 additional image assets from the selected completed output as new paid generation runs. The original stays intact, and each variation spends from the campaign budget."
        confirmLabel="Create variations"
        cancelLabel="Keep as is"
        pending={varyFor !== null}
        pendingLabel="Starting…"
        onConfirm={() => varyConfirm && void createVariations(varyConfirm)}
        onCancel={() => setVaryConfirm(null)}
      />

      {campaign.status === "approved" && campaign.publicationStatus !== "anchored" && campaign.publicationStatus !== "local" && (
        <p role="status" className="mt-3 break-words rounded-xl bg-amber-50 px-4 py-3 text-[12.5px] text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
          {campaign.publicationStatus === "failed"
            ? "Publishing failed - approve again to retry once the ledger is reachable."
            : "Public verification is pending for this record - approve again to publish it."}
        </p>
      )}
      {pendingRecords.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void republishPending()}
            disabled={republishing || active}
            aria-busy={republishing}
            title={active ? "Wait for production to finish before publishing records" : "Publish locally saved records to the proof ledger - already-published ones are skipped"}
            className="rounded-full"
          >
            {republishing ? "Publishing…" : `Publish ${pendingRecords.length} pending record${pendingRecords.length === 1 ? "" : "s"}`}
          </Button>
          {republishMsg && <p role="status" className="break-words text-[12px] text-muted-foreground">{republishMsg}</p>}
          {!republishMsg && (
            <p className="w-full text-[12px] leading-relaxed text-muted-foreground">
              Saved locally because the ledger was unreachable when generated. Publishing writes each to the proof ledger
              (giving it a permanent UAL and explorer link) - safe to retry, already-published records are skipped.
            </p>
          )}
        </div>
      )}
      {legacyHosted.length > 0 && (
        <div
          role="status"
          className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-sky-50 px-4 py-3 text-[12.5px] text-sky-800 ring-1 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-900"
        >
          <span className="min-w-0 flex-1 break-words">
            Provider-hosted legacy asset{legacyHosted.length === 1 ? "" : "s"} - store securely before sharing or publishing proof.
            Previews stay visible; share, download, and proof unlock once stored.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void retryStorage()}
            disabled={retryingStorage}
            aria-busy={retryingStorage}
            className="shrink-0 rounded-full"
          >
            {retryingStorage ? "Storing…" : "Store securely"}
          </Button>
          {storageMsg && <span className="w-full break-words text-[12px]">{storageMsg}</span>}
        </div>
      )}
      {storagePending.length > 0 && (
        <div
          role="status"
          className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-amber-50 px-4 py-3 text-[12.5px] text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900"
        >
          <span className="min-w-0 flex-1 break-words">
            {storagePending.length} output{storagePending.length === 1 ? "" : "s"} generated - saving securely. {storagePending.length === 1 ? "It" : "They"} will
            appear for review once stored; the provider result is safe meanwhile.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void retryStorage()}
            disabled={retryingStorage}
            aria-busy={retryingStorage}
            className="shrink-0 rounded-full"
          >
            {retryingStorage ? "Retrying…" : "Retry storage"}
          </Button>
          {storageMsg && <span className="w-full break-words text-[12px]">{storageMsg}</span>}
        </div>
      )}
      {hasTechnicalRecords && (
        <div className="mt-4 rounded-xl border border-border p-4">
          <button
            type="button"
            onClick={() => setShowTechnical((v) => !v)}
            aria-expanded={showTechnical}
            className="inline-flex items-center gap-1 text-[12px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            <ChevronDown className={cn("h-3.5 w-3.5 transition", showTechnical && "rotate-180")} aria-hidden />
            Technical details for verification
          </button>
          {showTechnical && (
            <div className="mt-3 space-y-2">
              {receiptRecords.map((r) => {
                const nftLink = r.ual ? blockExplorerNftUrl(r.ual) : null;
                return (
                  <p key={r.id} className="break-all font-mono text-[10.5px] text-muted-foreground" title={r.ual}>
                    <span className="text-foreground">{r.label}</span> · {r.ual}
                    {nftLink && (
                      <>
                        {" · "}
                        <a href={nftLink.href} target="_blank" rel="noreferrer" className="font-sans text-sky-700 hover:underline dark:text-sky-300">
                          {nftLink.label}
                        </a>
                      </>
                    )}
                  </p>
                );
              })}
              {campaignRecord && (
                <p className="break-all font-mono text-[10.5px] text-muted-foreground" title={campaignRecord}>
                  Campaign record · {campaignRecord}
                  {(() => {
                    const nftLink = blockExplorerNftUrl(campaignRecord);
                    return nftLink ? (
                      <>
                        {" · "}
                        <a href={nftLink.href} target="_blank" rel="noreferrer" className="font-sans text-sky-700 hover:underline dark:text-sky-300">
                          {nftLink.label}
                        </a>
                      </>
                    ) : null;
                  })()}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Lightbox: true aspect ratio, prev/next, evidence links. */}
      {lightboxReceipt && lightboxIndex !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${lightboxReceipt.label} — full size viewer`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
          onClick={() => setLightboxIndex(null)}
        >
          <div
            className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-card ring-1 ring-border"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-[14px] font-semibold">{lightboxReceipt.label}</p>
                <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                  {lightboxReceipt.format}
                  {lightboxReceipt.actualWidth !== undefined && lightboxReceipt.actualHeight !== undefined &&
                    ` · ${lightboxReceipt.actualWidth}×${lightboxReceipt.actualHeight}`}
                  {" · "}{lightboxReceipt.capability}
                  {campaign.receipts.length > 1 && ` · ${lightboxIndex + 1} of ${campaign.receipts.length}`}
                </p>
                {lightboxReceipt.aspectVerdict === "mismatch" &&
                  lightboxReceipt.actualWidth !== undefined &&
                  lightboxReceipt.actualHeight !== undefined && (
                    <p role="status" className="mt-0.5 text-[11.5px] font-medium text-amber-700 dark:text-amber-300">
                      Needs review — requested {lightboxReceipt.format}, received {describeActualSize(lightboxReceipt.actualWidth, lightboxReceipt.actualHeight)}.
                    </p>
                  )}
              </div>
              <button
                type="button"
                onClick={() => setLightboxIndex(null)}
                aria-label="Close viewer"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="relative flex min-h-0 items-center justify-center bg-black">
              {lightboxReceipt.mediaType === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={lightboxReceipt.outputUrl}
                  alt={lightboxReceipt.label}
                  className="max-h-[70vh] w-auto max-w-full object-contain"
                />
              ) : (
                <video
                  src={lightboxReceipt.outputUrl}
                  controls
                  autoPlay
                  preload="auto"
                  className="max-h-[70vh] w-auto max-w-full object-contain"
                />
              )}
              {campaign.receipts.length > 1 && (
                <>
                  <button
                    type="button"
                    onClick={() => setLightboxIndex((lightboxIndex - 1 + campaign.receipts.length) % campaign.receipts.length)}
                    aria-label="Previous output"
                    className="absolute left-2 grid h-9 w-9 place-items-center rounded-full bg-black/60 text-white hover:bg-black/80"
                  >
                    <ChevronLeft className="h-5 w-5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => setLightboxIndex((lightboxIndex + 1) % campaign.receipts.length)}
                    aria-label="Next output"
                    className="absolute right-2 grid h-9 w-9 place-items-center rounded-full bg-black/60 text-white hover:bg-black/80"
                  >
                    <ChevronRight className="h-5 w-5" aria-hidden />
                  </button>
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
              {campaign.verificationRef ? (
                <Link href={`/verify/${campaign.verificationRef}#output-${lightboxReceipt.id}`} className="inline-flex items-center gap-1 text-[12px] font-medium text-sky-700 hover:underline dark:text-sky-300">
                  Verify <ArrowRight className="h-3 w-3" />
                </Link>
              ) : (
                <span className="text-[12px] text-muted-foreground">Verify after approval</span>
              )}
              {(() => {
                const dl = downloadHrefFor(lightboxReceipt.outputUrl, lightboxReceipt.storageUrl);
                return (
                  <a
                    href={dl.href}
                    target="_blank"
                    rel="noreferrer"
                    download={dl.attachment ? true : undefined}
                    className="inline-flex items-center gap-1 text-[12px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    <Download className="h-3 w-3" /> Download
                  </a>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
