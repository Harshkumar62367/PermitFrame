"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, ChevronDown, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { campaignOutcome, OutcomeBadge } from "@/components/campaign-outcome";
import { apiPost } from "@/lib/api";
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
 * outputs, never when blocked) — this section only surfaces that gate.
 */
export function ReviewSection({ campaign, onChanged }: ReviewSectionProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
  const receiptRecords = campaign.receipts.filter((r) => r.ual);
  const campaignRecord = campaign.campaignUAL ?? approvedUal;
  const hasTechnicalRecords = receiptRecords.length > 0 || !!campaignRecord;

  async function approve() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const j = await apiPost<{ approved: boolean; campaignUAL?: string; verificationRef?: string | null; verificationWarning?: string | null }>(`/api/campaigns/${campaign.id}/approve`);
      setApprovedUal(j.campaignUAL ?? null);
      if (j.verificationWarning) setNotice(j.verificationWarning);
      invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approval failed.");
    } finally {
      setBusy(false);
    }
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
          ? "Verification link created from this approval's real data — share it from any output below."
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
          : "Nothing new published — the ledger is unreachable or records are already published. Check Settings › Asset production, then retry."
      );
      invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Republish failed. The ledger may be offline — retry once it is back.");
    } finally {
      setRepublishing(false);
    }
  }

  async function retryStorage() {
    if (retryingStorage) return;
    setRetryingStorage(true);
    setStorageMsg(null);
    setError(null);
    try {
      // Cloudinary imports run ~35s per asset — budget three minutes.
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
      setError(e instanceof Error ? e.message : "Storage retry failed — the provider result is intact; try again in a moment.");
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
              ? "No outputs yet — generated assets land here with their evidence."
              : `${campaign.receipts.length} output${campaign.receipts.length === 1 ? "" : "s"} · ${succeeded} stage${succeeded === 1 ? "" : "s"} succeeded`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {sharable && (
            <Button asChild variant="outline" size="sm" className="rounded-full" title="Download the offline evidence pack: brief, permission decision, per-stage costs and fingerprints, receipts, audit events. No prompts, no secrets — for client handoff, disputes, and archiving.">
              <a href={`/api/campaigns/${campaign.id}/bundle`} download>
                <Download className="h-3.5 w-3.5" /> Proof bundle
              </a>
            </Button>
          )}
          {campaign.status !== "approved" ? (
            <Button
              size="sm"
              onClick={() => void approve()}
              disabled={busy || active || succeeded === 0 || !sharable}
              aria-busy={busy}
              title={succeeded === 0 ? "Generate the pack first — there is nothing to approve yet" : active ? "Wait for production to finish before approving" : !sharable ? "Store outputs securely before approving — provider-hosted assets cannot be published as proof yet" : "Approve the pack — the campaign record publishes in the background"}
              className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
            >
              {busy ? "Approving…" : "Approve pack"}
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
            This pack was approved before public links existed. Create one now from this approval&apos;s real data —
            nothing is marked verified beyond what the record honestly carries.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refreshVerification()}
            disabled={refreshing || busy}
            aria-busy={refreshing}
            className="mt-3 rounded-full"
          >
            {refreshing ? "Creating link…" : "Refresh verification link"}
          </Button>
        </div>
      )}

      {error && <p role="alert" className="mt-3 break-words text-[12.5px] text-rose-600 dark:text-rose-300">{error}</p>}
      {notice && <p role="status" className="mt-3 break-words text-[12.5px] text-amber-700 dark:text-amber-300">{notice}</p>}

      {campaign.receipts.length > 0 ? (
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {campaign.receipts.map((r) => (
            <div key={r.id} className="group overflow-hidden rounded-xl bg-muted/60 ring-1 ring-border transition hover:ring-emerald-600/40">
              {r.mediaType === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.outputUrl} alt={r.label} loading="lazy" className="aspect-[3/4] w-full object-cover" />
              ) : (
                <video src={r.outputUrl} controls preload="metadata" className="aspect-[3/4] w-full bg-black object-contain" />
              )}
              <div className="space-y-1 p-3">
                <p className="text-[12.5px] font-medium leading-tight">{r.label}</p>
                <p className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">{r.format} · {r.capability}</p>
                <p className="text-[10.5px] text-muted-foreground" title={r.storageStatus === "stored" ? "Persisted to PermitFrame durable storage; the provider original stays on record" : "Provider-hosted legacy output — previewable, but not share-ready until stored securely"}>
                  {r.storageStatus === "stored" ? "Stored in PermitFrame" : r.storageStatus === "failed" ? "Storage failed" : "Provider-hosted legacy asset"}
                </p>
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
            Generate the selected deliverables above. If generation produces nothing, the queue shows exactly which stage failed and why — nothing is faked.
          </p>
        </div>
      )}

      {campaign.status === "approved" && campaign.publicationStatus !== "anchored" && campaign.publicationStatus !== "local" && (
        <p role="status" className="mt-3 break-words rounded-xl bg-amber-50 px-4 py-3 text-[12.5px] text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
          {campaign.publicationStatus === "failed"
            ? "Publishing failed — approve again to retry once the ledger is reachable."
            : "Public verification is pending for this record — approve again to publish it."}
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
            title={active ? "Wait for production to finish before publishing records" : "Publish locally saved records to the proof ledger — already-published ones are skipped"}
            className="rounded-full"
          >
            {republishing ? "Publishing…" : `Publish ${pendingRecords.length} pending record${pendingRecords.length === 1 ? "" : "s"}`}
          </Button>
          {republishMsg && <p role="status" className="break-words text-[12px] text-muted-foreground">{republishMsg}</p>}
          {!republishMsg && (
            <p className="w-full text-[12px] leading-relaxed text-muted-foreground">
              Saved locally because the ledger was unreachable when generated. Publishing writes each to the proof ledger
              (giving it a permanent UAL and explorer link) — safe to retry, already-published records are skipped.
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
            Provider-hosted legacy asset{legacyHosted.length === 1 ? "" : "s"} — store securely before sharing or publishing proof.
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
            {storagePending.length} output{storagePending.length === 1 ? "" : "s"} generated — saving securely. {storagePending.length === 1 ? "It" : "They"} will
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
    </section>
  );
}
