"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Archive,
  RefreshCw,
  Trash2,
  X
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FadeIn, VerdictCross } from "@/components/motion-primitives";
import { CampaignExtras } from "@/components/campaign-extras";
import { campaignOutcome, OutcomeBadge } from "@/components/campaign-outcome";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CreativeStudio } from "@/components/studio/creative-studio";
import { SimulationPanel } from "@/components/studio/simulation-panel";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { useInvalidateDkgGraph } from "@/lib/use-dkg-graph";
import { useInvalidateWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import type { Campaign, PermissionPassport, ProductFacts, SourceMedia } from "@/server/types";
import { cn } from "@/lib/utils";

interface DeletionInfo {
  deletable: boolean;
  archiveAvailable: boolean;
  reasons: string[];
  busy: boolean;
}

interface CampaignResponse {
  campaign: Campaign;
  sourceMedia: SourceMedia | null;
  passport: PermissionPassport | null;
  productFacts: ProductFacts | null;
  deletion: DeletionInfo;
}

export default function CampaignWorkspacePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [data, setData] = useState<CampaignResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"delete" | "archive" | null>(null);

  const [lastAction, setLastAction] = useState<{ label: string; path: string; body?: unknown } | null>(null);
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();
  const invalidateDkgGraph = useInvalidateDkgGraph();

  function requestCampaign(signal?: AbortSignal) {
    return apiGet<CampaignResponse>(`/api/campaigns/${id}`, signal);
  }

  useEffect(() => {
    const controller = new AbortController();
    requestCampaign(controller.signal).then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Campaign failed to load.");
      }
    );
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function reloadCampaign() {
    try {
      setData(await requestCampaign());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Campaign failed to load.");
    }
  }

  const active = useMemo(
    () => data?.campaign.jobs.some((j) => j.status === "queued" || j.status === "running") ?? false,
    [data]
  );

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void reloadCampaign(), 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function action(label: string, path: string, body?: unknown) {
    if (busy) return;
    setBusy(label);
    setLastAction({ label, path, body });
    setError(null);
    try {
      await apiPost(`/api/campaigns/${id}${path}`, body);
      // Policy simulation is what-if only and never changes the campaign;
      // every other action changes visible workspace data. Approval also
      // publishes the campaign record to the DKG.
      if (path !== "/simulate") invalidateSnapshot();
      if (path === "/approve") invalidateDkgGraph();
      await reloadCampaign();
    } catch (e) {
      // Campaign state is untouched; the buttons below retry the same action.
      setError(e instanceof Error ? e.message : `${label} failed.`);
    } finally {
      setBusy(null);
    }
  }

  if (error && !data) {
    return <div className="pf-page"><ErrorState message={error} onRetry={reloadCampaign} /></div>;
  }
  if (!data) return <div className="pf-page"><LoadingSkeleton rows={3} /></div>;

  const { campaign, sourceMedia, passport, productFacts, deletion } = data;
  const isArchived = campaign.status === "archived";
  const decision = campaign.preflight;
  const allowed = decision?.decision === "allow";
  const outcome = campaignOutcome({
    status: campaign.status,
    decision: decision?.decision ?? null,
    hasOutputs: campaign.receipts.length > 0,
    publicationStatus: campaign.publicationStatus,
    campaignUAL: campaign.campaignUAL
  });

  async function reloadAfterStudio() {
    invalidateSnapshot();
    await reloadCampaign();
  }

  /**
   * Delete / archive with confirmation. Server-side idempotency makes
   * double-clicks and retries safe; `busy` serializes the UI regardless.
   */
  async function runDeletion(mode: "delete" | "archive") {
    if (busy) return;
    setBusy(mode);
    setError(null);
    setNotice(null);
    try {
      if (mode === "delete") {
        const res = await apiDelete<{ deleted: boolean; alreadyDeleted?: boolean; title: string }>(`/api/campaigns/${id}`);
        setConfirm(null);
        invalidateSnapshot();
        // Success feedback stays visible briefly, then the (now empty) detail
        // route is left for the Campaigns list, which refreshes from cache.
        setNotice(`“${res.title}” deleted. Returning to Campaigns…`);
        setTimeout(() => router.push("/campaigns"), 900);
      } else {
        const res = await apiPost<{ archived: boolean; alreadyArchived?: boolean; title: string }>(`/api/campaigns/${id}/archive`);
        setConfirm(null);
        invalidateSnapshot();
        setNotice(`“${res.title}” archived — kept for audit history, hidden from lists.`);
        await reloadCampaign();
      }
    } catch (e) {
      setConfirm(null);
      setError(e instanceof Error ? e.message : `${mode === "delete" ? "Delete" : "Archive"} failed — nothing was changed.`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="pf-page space-y-7">
      {/* Header */}
      <FadeIn>
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0 max-w-2xl">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display text-balance text-3xl font-semibold tracking-tight">{campaign.title}</h1>
              <OutcomeBadge outcome={outcome} />
            </div>
            {outcome.explanation && (
              <p className="mt-1.5 text-[13px] text-muted-foreground">{outcome.explanation}</p>
            )}
            <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              {campaign.brand} {campaign.productName} · {campaign.request.platform} · {campaign.request.country} · {campaign.request.transformation} pack
            </p>
            <p className="mt-3 text-[14px] italic leading-relaxed text-muted-foreground">“{campaign.request.creativeBrief}”</p>
          </div>
          {sourceMedia && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={sourceMedia.url} alt="source media" className="h-24 w-16 rounded-xl object-cover ring-1 ring-border" />
          )}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Chip label="claims requested" value={campaign.request.requestedClaims.join(", ") || "—"} />
          <Chip label="passport" value={passport?.id ?? "—"} mono />
          <Chip label="facts" value={productFacts?.id ?? "—"} mono />
        </div>
      </FadeIn>

      {/* Archived campaigns are read-only audit history */}
      {isArchived && (
        <div
          role="status"
          className="rounded-xl bg-muted/60 px-4 py-3 text-[13px] leading-relaxed text-muted-foreground ring-1 ring-border"
        >
          <span className="font-medium text-foreground">Archived.</span> This campaign is kept for audit history —
          hidden from Campaigns and Overview, read-only here. It cannot be edited, produced, approved, or deleted.
        </div>
      )}

      {/* Success feedback (delete/archive): visible, then navigation follows */}
      {notice && (
        <div
          role="status"
          className="rounded-xl bg-emerald-50 px-4 py-3 text-[13px] text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900"
        >
          {notice}
        </div>
      )}

      {/* Action errors: visible, retryable, dismissible — state is untouched */}
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2.5 rounded-xl bg-rose-50 px-4 py-3 text-[13px] text-rose-800 ring-1 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900"
        >
          <span className="min-w-0 flex-1 break-words">{error}</span>
          {lastAction && (
            <button
              type="button"
              onClick={() => action(lastAction.label, lastAction.path, lastAction.body)}
              disabled={busy !== null}
              className="shrink-0 rounded-full px-3 py-1 text-[12px] font-medium underline underline-offset-2 hover:no-underline disabled:opacity-50"
            >
              Retry{busy ? "…" : ""}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setError(null);
              setLastAction(null);
            }}
            className="shrink-0 rounded-full px-3 py-1 text-[12px] font-medium text-rose-700 underline underline-offset-2 hover:no-underline dark:text-rose-300"
          >
            Dismiss
          </button>
        </div>
      )}

      {!decision && !isArchived && (
        <FadeIn delay={0.05}>
          <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-6 dark:border-amber-900 dark:bg-amber-950/30">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-800 dark:text-amber-300">Ready for permission check</p>
            <h2 className="mt-2 text-[16px] font-semibold">Run the permission check before production</h2>
            <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">This workspace loaded from Neon. Running this check now verifies creator rights and brand rules, then stores the decision for this campaign.</p>
            <Button
              size="sm"
              onClick={() => action("repreflight", "/repreflight")}
              disabled={busy !== null}
              aria-busy={busy === "repreflight"}
              className="mt-4 rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", busy === "repreflight" && "animate-spin")} aria-hidden /> {busy === "repreflight" ? "Checking permissions…" : "Run permission check"}
            </Button>
          </section>
        </FadeIn>
      )}

      {/* Blocked verdict: reasons plus the exact fix. Approved campaigns render the Creative Studio below instead. */}
      {decision && !allowed && (
        <FadeIn delay={0.05}>
          <div
            id="evidence"
            className="scroll-mt-24 overflow-hidden rounded-2xl border border-rose-200 bg-gradient-to-b from-rose-50/80 to-card dark:border-rose-900 dark:from-rose-950/40"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-inherit px-6 py-4">
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-full bg-rose-600 text-rose-50">
                  <VerdictCross className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-[15px] font-semibold text-rose-900 dark:text-rose-200">
                    Changes needed before creation
                  </p>
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-rose-700 dark:text-rose-300/70">
                    {decision.blockers.length} precise reason{decision.blockers.length === 1 ? "" : "s"} — no production spend
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {!isArchived && (
                  <>
                    <Button asChild variant="outline" size="sm" className="rounded-full">
                      <Link href="/consents">Fix creator permissions</Link>
                    </Button>
                    <Button asChild variant="outline" size="sm" className="rounded-full">
                      <Link href="/products">Fix brand rules</Link>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => action("repreflight", "/repreflight")}
                      disabled={busy !== null}
                      aria-busy={busy === "repreflight"}
                      className="rounded-full"
                    >
                      <RefreshCw className={cn("h-3.5 w-3.5", busy === "repreflight" && "animate-spin")} aria-hidden /> {busy === "repreflight" ? "Checking…" : "Re-check rights"}
                    </Button>
                  </>
                )}
              </div>
            </div>

            <div className="px-6 py-5">
              <div className="space-y-2.5">
                {decision.blockers.map((b, i) => (
                  <motion.div
                    key={b.code + i}
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.15 + i * 0.1 }}
                    className="flex items-start gap-3 rounded-xl bg-rose-100/60 p-3.5 ring-1 ring-rose-200 dark:bg-rose-950/50 dark:ring-rose-900"
                  >
                    <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-rose-600 text-white"><X className="h-3 w-3" /></span>
                    <div>
                      <p className="text-[13.5px] font-medium leading-snug text-rose-950 dark:text-rose-100">{b.message}</p>
                      <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-rose-700 dark:text-rose-300/70">
                        {b.code} · evidence: {b.evidenceRefs.join(", ") || "no approved rights or brand rules matched"}
                      </p>
                      <p className="mt-1.5 text-[12px] leading-relaxed text-rose-900/80 dark:text-rose-200/80">
                        Fix: adjust the brief to match the cited rights or brand rules, then re-check. Nothing generates while blocked.
                      </p>
                    </div>
                  </motion.div>
                ))}
              </div>

              <div className="mt-4">
                <SimulationPanel campaignId={campaign.id} sparqlPreview={decision.sparqlPreview} />
              </div>
            </div>
          </div>
        </FadeIn>
      )}

      {/* Creative Studio — approved campaigns only, never archived ones */}
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

      {/* Danger zone — delete drafts, archive everything else worth keeping */}
      {!isArchived && (
        <section aria-label="Danger zone" className="rounded-2xl border border-border p-6">
          <h2 className="text-[15px] font-semibold tracking-tight">Danger zone</h2>
          {deletion.deletable ? (
            <>
              <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
                This campaign has no generated assets, no share link, and no public proof — it exists only in this
                workspace. Deleting removes the draft, its permission-check record, and its ungenerated plan items.
                Workspace activity entries that mention it stay. Nothing on the shared ledger is touched.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirm("delete")}
                disabled={busy !== null}
                className="mt-4 rounded-full border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950/40"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete campaign
              </Button>
            </>
          ) : (
            <>
              <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
                This campaign cannot be deleted:
              </p>
              <ul className="mt-2 max-w-2xl list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-muted-foreground">
                {deletion.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              {deletion.archiveAvailable ? (
                <>
                  <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
                    Archive it instead: the full record stays readable here and in history, but it leaves Campaigns and Overview.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirm("archive")}
                    disabled={busy !== null}
                    className="mt-4 rounded-full"
                  >
                    <Archive className="h-3.5 w-3.5" aria-hidden /> Archive campaign
                  </Button>
                </>
              ) : (
                <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
                  Neither option is available right now — wait until production settles, then come back.
                </p>
              )}
            </>
          )}
        </section>
      )}

      <ConfirmDialog
        open={confirm === "delete"}
        title={`Delete “${campaign.title}”?`}
        consequence="This permanently removes the draft, its permission-check record, and its ungenerated plan items from this workspace. Activity entries that mention it stay. This cannot be undone — but it touches only workspace data; the shared ledger is never modified."
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
    </div>
  );
}

function Chip({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-[11.5px] ring-1 ring-border">
      <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
      <span className={cn("pf-id text-foreground/80", mono && "font-mono text-[11px]")} title={value}>{value}</span>
    </span>
  );
}
