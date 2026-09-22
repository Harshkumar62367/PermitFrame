"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FadeIn } from "@/components/motion-primitives";
import { CampaignExtras } from "@/components/campaign-extras";
import { CampaignHeader } from "@/components/campaign-detail/campaign-header";
import { CampaignFeedback } from "@/components/campaign-detail/campaign-feedback";
import { CampaignPreflightPanel } from "@/components/campaign-detail/campaign-preflight-panel";
import { CampaignBlockedVerdict } from "@/components/campaign-detail/campaign-blocked-verdict";
import { CampaignDangerZone } from "@/components/campaign-detail/campaign-danger-zone";
import { ArchivedRecordDangerZone } from "@/components/campaign-detail/archived-record-danger-zone";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CreativeStudio } from "@/components/studio/creative-studio";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { apiDelete, apiPost } from "@/lib/api";
import { useLongAction } from "@/lib/use-long-action";
import { campaignDetailKey, useCampaignDetail } from "@/lib/use-campaign";
import { useInvalidateDkgGraph } from "@/lib/use-dkg-graph";
import { useInvalidateWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import { isActiveJobStatus } from "@/server/types";

// Live progress polling while jobs run: starts at 3s, backs off to 30s on
// consecutive background failures. See reloadCampaign below.
const POLL_BASE_MS = 3000;
const POLL_MAX_MS = 30000;

export default function CampaignWorkspacePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const queryClient = useQueryClient();
  // Cached detail: hover-prefetch warms this, back-navigation reuses it
  // (stale 30s, background-refetch). Server data is always the truth -
  // the cache only hides the fetch latency, never substitutes summaries.
  const { data, error: queryError, refetch } = useCampaignDetail(id);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"delete" | "archive" | "force" | null>(null);
  const [forceName, setForceName] = useState("");

  const [lastAction, setLastAction] = useState<{ label: string; path: string; body?: unknown } | null>(null);
  const reloadInflight = useRef(false);
  const pollBackoffMs = useRef(POLL_BASE_MS);
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();
  const invalidateDkgGraph = useInvalidateDkgGraph();
  // Permission evaluation consults the live ledger and can legitimately
  // outlast the default 30s browser budget - same 120s policy as the studio
  // re-check, with slow status and refresh-first recovery. Retries stay
  // manual (the retry button below); nothing reruns automatically and no
  // duplicate campaign is ever created by a timed-out check.
  const recheck = useLongAction({
    working: "Checking permissions…",
    slow: "Still checking approved rights and brand rules. Please keep this page open.",
    timedOut:
      "The permission check is taking longer than expected. Refresh once before retrying - the result may already be available."
  });

  function requestCampaign() {
    return refetch({ throwOnError: false }).then((r) => {
      if (r.data) return r.data;
      throw r.error ?? new Error("Campaign failed to load.");
    });
  }

  // Derived (no effect): query failure shows only when no cached data exists;
  // background-tick failures keep old rows and back off silently.
  const error = actionError ?? ((!data && queryError) ? (queryError instanceof Error ? queryError.message : "Campaign failed to load.") : null);

  async function reloadCampaign(quiet = false) {
    // Single-flight: a slow tick must never stack overlapping requests, and
    // background ticks back off on consecutive failures instead of flashing
    // error banners while jobs run. Only the initial load and user actions
    // surface errors; the interval below resets the backoff on success.
    if (reloadInflight.current) return;
    reloadInflight.current = true;
    try {
      await queryClient.invalidateQueries({ queryKey: campaignDetailKey(id) });
      await requestCampaign();
      setActionError(null);
      pollBackoffMs.current = POLL_BASE_MS;
    } catch (e) {
      if (!quiet) setActionError(e instanceof Error ? e.message : "Campaign failed to load.");
      else pollBackoffMs.current = Math.min(pollBackoffMs.current * 2, POLL_MAX_MS);
    } finally {
      reloadInflight.current = false;
    }
  }

  const active = useMemo(
    () => data?.campaign.jobs.some((j) => isActiveJobStatus(j.status)) ?? false,
    [data]
  );

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (cancelled) return;
      void reloadCampaign(true).finally(() => {
        if (!cancelled) timer = setTimeout(tick, pollBackoffMs.current);
      });
    };
    timer = setTimeout(tick, pollBackoffMs.current);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function action(label: string, path: string, body?: unknown) {
    if (busy) return;
    setBusy(label);
    setLastAction({ label, path, body });
    setActionError(null);
    try {
      // The only caller is the permission re-check (initial + blocked
      // states), which evaluates live rights - budget two minutes.
      const result = path === "/repreflight"
        ? await recheck.execute(() => apiPost(`/api/campaigns/${id}${path}`, body, undefined, recheck.timeoutMs))
        : await apiPost(`/api/campaigns/${id}${path}`, body)
            .then(() => ({ ok: true as const, message: null as string | null }))
            .catch((e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : `${label} failed.` }));
      if (!result.ok) {
        // Campaign state is untouched; the retry button below retries the
        // same action manually - a timed-out check never reruns by itself.
        if (result.message) setActionError(result.message);
        return;
      }
      // Policy simulation is what-if only and never changes the campaign;
      // every other action changes visible workspace data. Approval also
      // publishes the campaign record to the DKG.
      if (path !== "/simulate") invalidateSnapshot();
      if (path === "/approve") invalidateDkgGraph();
      await reloadCampaign();
    } catch (e) {
      // Campaign state is untouched; the buttons below retry the same action.
      setActionError(e instanceof Error ? e.message : `${label} failed.`);
    } finally {
      setBusy(null);
    }
  }

  if (error && !data) {
    return <div className="pf-page space-y-7"><ErrorState message={error} onRetry={reloadCampaign} className="mx-auto w-full max-w-3xl" /></div>;
  }
  if (!data) return <div className="pf-page space-y-7"><LoadingSkeleton rows={3} /></div>;

  const { campaign, sourceMedia, passport, productFacts, deletion } = data;
  const isArchived = campaign.status === "archived";
  const decision = campaign.preflight;
  const allowed = decision?.decision === "allow";
  async function reloadAfterStudio() {
    invalidateSnapshot();
    await reloadCampaign();
  }

  /**
   * Delete / archive / force-delete with confirmation. Server-side idempotency
   * makes double-clicks and retries safe; `busy` serializes the UI regardless.
   */
  async function runDeletion(mode: "delete" | "archive" | "force") {
    if (busy) return;
    setBusy(mode);
    setActionError(null);
    setNotice(null);
    try {
      if (mode === "delete" || mode === "force") {
        const res = await apiDelete<{ deleted: boolean; alreadyDeleted?: boolean; title: string }>(
          mode === "force" ? `/api/campaigns/${id}?force=true` : `/api/campaigns/${id}`
        );
        setConfirm(null);
        setForceName("");
        invalidateSnapshot();
        // Carry the confirmation across the redirect: the list page shows a
        // dismissible success banner (the detail page unmounts too fast for
        // its own notice to be reliably seen).
        const deletedTitle = res.title;
        setNotice(`“${deletedTitle}” deleted. Returning to Campaigns…`);
        setTimeout(() => router.push(`/campaigns?deleted=${encodeURIComponent(deletedTitle)}`), 900);
      } else {
        const res = await apiPost<{ archived: boolean; alreadyArchived?: boolean; title: string }>(`/api/campaigns/${id}/archive`);
        setConfirm(null);
        invalidateSnapshot();
        setNotice(`“${res.title}” archived - kept for audit history, hidden from lists.`);
        await reloadCampaign();
      }
    } catch (e) {
      setConfirm(null);
      setActionError(e instanceof Error ? e.message : `${mode === "delete" ? "Delete" : mode === "force" ? "Force delete" : "Archive"} failed - nothing was changed.`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="pf-page space-y-7">
      <CampaignHeader campaign={campaign} sourceMedia={sourceMedia} passport={passport} productFacts={productFacts} />

      {/* Archived campaigns are read-only audit history */}
      {isArchived && (
        <div
          role="status"
          className="rounded-xl bg-muted/60 px-4 py-3 text-[13px] leading-relaxed text-muted-foreground ring-1 ring-border"
        >
          <span className="font-medium text-foreground">Archived.</span> This campaign is kept for audit history -
          hidden from Campaigns and Overview, read-only here. It cannot be edited, produced, or approved.
        </div>
      )}

      {/* Last resort: permanent removal of an archived record. Deliberately
          collapsed and type-to-confirm - destroying history must never be a
          casual click. */}
      {isArchived && (
        <ArchivedRecordDangerZone
          campaignId={id}
          campaignTitle={campaign.title}
          warnings={deletion.force.warnings}
          forceAllowed={deletion.force.allowed}
          forceReasons={deletion.force.reasons}
          forceName={forceName}
          onForceNameChange={setForceName}
          disabled={busy !== null}
          onRequestForce={() => setConfirm("force")}
        />
      )}

      <CampaignFeedback
        notice={notice}
        error={error}
        busy={busy !== null}
        canRetry={lastAction !== null}
        onRetry={() => { if (lastAction) void action(lastAction.label, lastAction.path, lastAction.body); }}
        onDismiss={() => { setActionError(null); setLastAction(null); }}
      />

      {!decision && !isArchived && (
        <FadeIn delay={0.05}>
          <CampaignPreflightPanel
            checking={busy === "repreflight"}
            disabled={busy !== null}
            status={recheck.busy ? recheck.status : null}
            onRun={() => action("repreflight", "/repreflight")}
          />
        </FadeIn>
      )}

      {/* Blocked verdict: reasons plus the exact fix. Approved campaigns render the Creative Studio below instead. */}
      {decision && !allowed && (
        <FadeIn delay={0.05}>
          <CampaignBlockedVerdict
            decision={decision}
            isArchived={isArchived}
            checking={busy === "repreflight"}
            disabled={busy !== null}
            status={recheck.busy ? recheck.status : null}
            onRecheck={() => action("repreflight", "/repreflight")}
            campaignId={campaign.id}
          />
        </FadeIn>
      )}

      {/* Creative Studio - approved campaigns only, never archived ones */}
      {decision && allowed && !isArchived && (
        <FadeIn delay={0.05}>
          <CreativeStudio
            campaign={campaign}
            sourceMedia={sourceMedia}
            passport={passport}
            productFacts={productFacts}
            onChanged={reloadAfterStudio}
          />
        </FadeIn>
      )}

      {!isArchived && campaign.status !== "blocked" && <CampaignExtras campaign={campaign} hideVariants />}

      {/* Danger zone - delete drafts, archive everything else worth keeping */}
      {!isArchived && (
        <CampaignDangerZone
          disabled={busy !== null}
          deletable={deletion.deletable}
          reasons={deletion.reasons}
          archiveAvailable={deletion.archiveAvailable}
          onDelete={() => setConfirm("delete")}
          onArchive={() => setConfirm("archive")}
        />
      )}

      <ConfirmDialog
        open={confirm === "delete"}
        title={`Delete “${campaign.title}”?`}
        consequence="This permanently removes the draft, its permission-check record, and its ungenerated plan items from this workspace. Activity entries that mention it stay. This cannot be undone - but it touches only workspace data; the shared ledger is never modified."
        confirmLabel="Delete campaign"
        cancelLabel="Keep campaign"
        pending={busy === "delete"}
        pendingLabel="Deleting…"
        onConfirm={() => runDeletion("delete")}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "archive"}
        title={`Archive “${campaign.title}”?`}
        consequence="The full record stays readable here and in history, but the campaign leaves Campaigns and Overview and becomes read-only. Use this for anything with generated assets, a share link, or public proof."
        confirmLabel="Archive campaign"
        cancelLabel="Keep as is"
        pending={busy === "archive"}
        pendingLabel="Archiving…"
        onConfirm={() => runDeletion("archive")}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "force"}
        title={`Permanently delete archived “${campaign.title}”?`}
        consequence="Last resort. The workspace record - brief, jobs, outputs and plan - is destroyed forever, and any share link breaks. Published verification snapshots and ledger data survive. This cannot be undone."
        confirmLabel="Delete forever"
        cancelLabel="Keep archived record"
        pending={busy === "force"}
        pendingLabel="Deleting…"
        onConfirm={() => runDeletion("force")}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
