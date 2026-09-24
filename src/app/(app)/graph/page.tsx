"use client";

import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { SectionCard } from "@/components/ui/section-card";
import { CopyableIdentifier } from "@/components/ui/identifier";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { HealthDot } from "@/components/ui/integration-status";
import { baseSepoliaTransactionUrl, blockExplorerNftUrl } from "@/lib/proof-links";
import { useDkgGraph, type DkgAsset, type DkgHealth } from "@/lib/use-dkg-graph";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export default function GraphPage() {
  // Slow DKG reads live under the separate ["dkg-graph"] key - never in the
  // workspace snapshot, never blocking app navigation. The last known health
  // and asset list render immediately from cache and refresh in the
  // background; the shell and explanation below always render.
  const graph = useDkgGraph();
  const health: DkgHealth | null = graph.data?.health ?? null;
  const assets: DkgAsset[] = graph.data?.assets ?? [];
  const loadError = !graph.data && graph.isError
    ? (graph.error instanceof Error ? graph.error.message : "Proof records failed to load.")
    : null;

  return (
    <div className="pf-page space-y-8">
      <Link href="/verifier" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-emerald-700 hover:underline dark:text-emerald-300">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Back to Verification
      </Link>
      <PageHeader
        eyebrow="Verification · Advanced"
        title="Proof inspector"
        description="A technical view of the underlying proof records behind campaigns, permissions, and brand rules. Most producers never need this - Verification covers day-to-day review."
      />

      {loadError && <ErrorState message={loadError} onRetry={() => { void graph.refetch(); }} />}

      {!health && !loadError && <LoadingSkeleton rows={1} />}

      {health && (
        <SectionCard>
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <HealthDot healthy={health.healthy} />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                DKG: {health.mode === "edge-node" ? "V10 Edge Node" : "local evidence mode"}
              </p>
              <p className="mt-0.5 break-words text-xs text-muted-foreground">{health.status}</p>
              {health.mode === "local-evidence" && (
                <p className="mt-1.5 break-words text-xs leading-relaxed text-muted-foreground">
                  Honest note: this table lists what the local evidence store can read back. Passport or
                  fact identifiers shown on other screens are stored references - if this list is empty while
                  references exist elsewhere, the store file was cleared or a different data directory is in
                  use. Nothing here is fabricated.
                </p>
              )}
              {health.mode === "edge-node" && (
                <p className="mt-1.5 break-words text-xs leading-relaxed text-muted-foreground">
                  Honest note: results come from live Shared Working Memory. An empty list means the context
                  graph holds no matching assets yet - identifiers elsewhere are stored references, not live
                  graph proof.
                </p>
              )}
            </div>
          </div>
        </SectionCard>
      )}

      <section aria-label="Proof records">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold tracking-tight">Proof records</h2>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-muted-foreground">{assets.length} published</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { void graph.refetch(); }}
              disabled={graph.isFetching}
              aria-busy={graph.isFetching}
              title="Force a live proof-ledger read, ignoring the cache"
              className="h-7 rounded-full px-2.5 text-[11.5px]"
            >
              <RefreshCw className={graph.isFetching ? "h-3 w-3 animate-spin" : "h-3 w-3"} aria-hidden />
              {graph.isFetching ? "Refreshing…" : "Refresh records"}
            </Button>
          </div>
        </div>
        {graph.data && (
          <p className="mb-3 text-[11.5px] text-muted-foreground">
            Cached view · last synced {new Date(graph.dataUpdatedAt).toLocaleTimeString()} · Refresh for a live read.
            Cached records are never decision truth - permission checks, publishing, renewal, revocation, and approval always query live.
          </p>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {assets.map((a, index) => {
            const type = typeof a.content["@type"] === "string" ? (a.content["@type"] as string) : "";
            // SWM assets intentionally have no on-chain UAL. Their assertion URI
            // is unique evidence; fall back to the render position only for an
            // incomplete local record so React never receives duplicate empty keys.
            const assetKey = a.ual || a.evidenceUri || `${a.name}-${index}`;
            return (
              <article key={assetKey} className="min-w-0 rounded-xl border border-border bg-card p-5">
                <div className="flex items-center justify-between gap-3">
                  {type ? (
                    <span className="truncate rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-700/40">
                      {type}
                    </span>
                  ) : (
                    <span />
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground">{formatDate(a.publishedAt)}</span>
                </div>
                <h3 className="mt-3 break-words font-medium text-foreground">{a.name}</h3>
                {(a.ual || a.evidenceUri) && (
                  <CopyableIdentifier value={a.ual || a.evidenceUri!} className="mt-2 max-w-full text-xs" />
                )}
                {(() => {
                  const nftLink = a.ual ? blockExplorerNftUrl(a.ual) : null;
                  const transactionLink = baseSepoliaTransactionUrl(a.ual, a.txHash);
                  if (!a.explorerUrl && !nftLink && !transactionLink) {
                    return <p className="mt-3 text-[11px] text-muted-foreground">Working Memory only - no explorer anchor yet.</p>;
                  }
                  return (
                    <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium">
                      {a.explorerUrl && (
                        <a
                          href={a.explorerUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-emerald-700 hover:text-emerald-600 dark:text-emerald-300 dark:hover:text-emerald-200"
                        >
                          explorer →
                        </a>
                      )}
                      {nftLink && (
                        <a
                          href={nftLink.href}
                          target="_blank"
                          rel="noreferrer"
                          title="Testnet tokens are not indexed by the OriginTrail explorer - view the token contract directly"
                          className="text-emerald-700 hover:text-emerald-600 dark:text-emerald-300 dark:hover:text-emerald-200"
                        >
                          {nftLink.label} →
                        </a>
                      )}
                      {transactionLink && (
                        <a
                          href={transactionLink.href}
                          target="_blank"
                          rel="noreferrer"
                          className="text-emerald-700 hover:text-emerald-600 dark:text-emerald-300 dark:hover:text-emerald-200"
                        >
                          {transactionLink.label} →
                        </a>
                      )}
                    </p>
                  );
                })()}
              </article>
            );
          })}
          {health && assets.length === 0 && !loadError && (
            <EmptyState title="No proof records readable" body="Either nothing has been recorded yet, or the proof store differs from the workspace database. Identifiers on other screens are stored references - this list only shows live reads." />
          )}
        </div>
      </section>
    </div>
  );
}
