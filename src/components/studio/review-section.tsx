"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { campaignOutcome, OutcomeBadge } from "@/components/campaign-outcome";
import type { Campaign } from "@/server/types";
import { deliveryBlockReason, hasSharableReceipt, isActiveJobStatus, isDeliverableReceipt } from "@/server/types";
import { deriveQualityReview } from "@/server/livepeer/quality-review";
import { canCreateVariations } from "./studio-model";
import { useReviewActions } from "./use-review-actions";
import { ReviewAssetCard } from "./review-asset-card";
import { ReviewLightbox } from "./review-lightbox";
import { ReviewTechnicalDetails } from "./review-technical-details";
import { ReviewStorageNotices } from "./review-storage-notices";

interface ReviewSectionProps {
  campaign: Campaign;
  onChanged: () => Promise<void>;
}
/**
 * Review & deliver: real outputs with per-asset evidence, the proof bundle,
 * and the approve action. Approval stays gated server-side (needs succeeded
 * outputs, never when blocked) - this section only surfaces that gate.
 *
 * State ownership: this parent owns selection and disclosure (lightbox
 * index + keyboard traversal, technical toggle) and composes the
 * view-only children below. All mutations live in useReviewActions;
 * children never fetch, mutate, poll, or hold competing selection.
 */
export function ReviewSection({ campaign, onChanged }: ReviewSectionProps) {
  const actions = useReviewActions(campaign, onChanged);
  const [showTechnical, setShowTechnical] = useState(false);
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
  const receiptRecords = campaign.receipts.filter((r) => r.ual);
  const campaignRecord = campaign.campaignUAL ?? actions.approvedUal;
  const hasTechnicalRecords = receiptRecords.length > 0 || !!campaignRecord;
  // Concise pack review for the approval decision: counts over production
  // receipts (joined to jobs). Advisory critique flags inform only - the
  // aspect-ratio block remains the sole automatic technical refusal.
  const productionReceipts = campaign.receipts.filter((r) => campaign.jobs.some((j) => j.id === r.jobId));
  const packStates = productionReceipts.map((r) => deriveQualityReview(campaign.jobs.find((j) => j.id === r.jobId), r).state);
  const packDelivered = productionReceipts.filter((r) => isDeliverableReceipt(r)).length;
  const packBlocked = productionReceipts.filter((r) => deliveryBlockReason(r) !== null).length;
  const packAttention = packStates.filter((s) => s === "needs_attention").length;
  const packUnassessed = packStates.filter((s) => s === "not_assessed").length;

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
              onClick={() => void actions.approve()}
              disabled={actions.approval.busy || active || succeeded === 0 || !sharable}
              aria-busy={actions.approval.busy}
              title={succeeded === 0 ? "Generate the pack first - there is nothing to approve yet" : active ? "Wait for production to finish before approving" : !sharable ? "Store outputs securely before approving - provider-hosted assets cannot be published as proof yet" : "Approve the pack - the campaign record publishes in the background"}
              className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
            >
              {actions.approval.busy ? "Recording approval…" : "Approve pack"}
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
            onClick={() => void actions.refreshVerification()}
            disabled={actions.refreshing || actions.approval.busy}
            aria-busy={actions.refreshing}
            className="mt-3 rounded-full"
          >
            {actions.refreshing ? "Creating link…" : "Refresh verification link"}
          </Button>
        </div>
      )}

      {actions.error && <p role="alert" className="mt-3 break-words text-[12.5px] text-rose-600 dark:text-rose-300">{actions.error}</p>}
      {actions.approval.busy && actions.approval.status && (
        <p role="status" className="mt-3 break-words text-[12.5px] text-muted-foreground">{actions.approval.status}</p>
      )}
      {actions.notice && <p role="status" className="mt-3 break-words text-[12.5px] text-amber-700 dark:text-amber-300">{actions.notice}</p>}
      {productionReceipts.length > 0 && (
        <p role="status" className="mt-3 break-words text-[12px] text-muted-foreground">
          Pack review: {packDelivered} deliverable · {packBlocked} ratio-blocked · {packAttention} flagged for attention · {packUnassessed} unassessed.
          Advisory flags need human judgment - ratio mismatches and failed identity checks refuse approval automatically. Product- and property-preserving outputs earn their pill only when the identity check passes; reference-guided outputs never claim preservation.
        </p>
      )}

      {campaign.receipts.length > 0 ? (
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {campaign.receipts.map((r, i) => {
            const job = campaign.jobs.find((j) => j.id === r.jobId);
            return (
              <ReviewAssetCard
                key={r.id}
                receipt={r}
                job={job ?? null}
                index={i}
                canVary={canCreateVariations(r, job?.status)}
                active={active}
                regenFor={actions.regenFor}
                varyFor={actions.varyFor}
                verificationRef={campaign.verificationRef ?? null}
                onRegenerate={actions.regenerate}
                onRequestVary={actions.setVaryConfirm}
                onOpen={setLightboxIndex}
              />
            );
          })}
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
        open={actions.varyConfirm !== null}
        title="Create 2 variations?"
        consequence="This derives 2 additional image assets from the selected completed output as new paid generation runs. The original stays intact, and each variation spends from the campaign budget."
        confirmLabel="Create variations"
        cancelLabel="Keep as is"
        pending={actions.varyFor !== null}
        pendingLabel="Starting…"
        onConfirm={() => actions.varyConfirm && void actions.createVariations(actions.varyConfirm)}
        onCancel={() => actions.setVaryConfirm(null)}
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
            onClick={() => void actions.republishPending()}
            disabled={actions.republishing || active}
            aria-busy={actions.republishing}
            title={active ? "Wait for production to finish before publishing records" : "Publish locally saved records to the proof ledger - already-published ones are skipped"}
            className="rounded-full"
          >
            {actions.republishing ? "Publishing…" : `Publish ${pendingRecords.length} pending record${pendingRecords.length === 1 ? "" : "s"}`}
          </Button>
          {actions.republishMsg && <p role="status" className="break-words text-[12px] text-muted-foreground">{actions.republishMsg}</p>}
          {!actions.republishMsg && (
            <p className="w-full text-[12px] leading-relaxed text-muted-foreground">
              Saved locally because the ledger was unreachable when generated. Publishing writes each to the proof ledger
              (giving it a permanent UAL and explorer link) - safe to retry, already-published records are skipped.
            </p>
          )}
        </div>
      )}
      <ReviewStorageNotices
        legacyCount={legacyHosted.length}
        pendingCount={storagePending.length}
        retrying={actions.retryingStorage}
        message={actions.storageMsg}
        onRetry={actions.retryStorage}
      />
      {hasTechnicalRecords && (
        <ReviewTechnicalDetails
          receipts={receiptRecords}
          campaignRecord={campaignRecord}
          campaignTxHash={campaign.campaignTxHash ?? null}
          open={showTechnical}
          onToggle={() => setShowTechnical((v) => !v)}
        />
      )}

      {/* Lightbox: true aspect ratio, prev/next, evidence links. */}
      {lightboxReceipt && lightboxIndex !== null && (
        <ReviewLightbox
          receipt={lightboxReceipt}
          index={lightboxIndex}
          total={campaign.receipts.length}
          verificationRef={campaign.verificationRef ?? null}
          onClose={() => setLightboxIndex(null)}
          onPrev={() => setLightboxIndex((lightboxIndex - 1 + campaign.receipts.length) % campaign.receipts.length)}
          onNext={() => setLightboxIndex((lightboxIndex + 1) % campaign.receipts.length)}
        />
      )}
    </section>
  );
}
