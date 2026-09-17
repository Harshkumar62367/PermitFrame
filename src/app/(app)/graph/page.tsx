"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { ArrowLeft, Check, Copy, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { SectionCard } from "@/components/ui/section-card";
import { CopyableIdentifier } from "@/components/ui/identifier";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { HealthDot } from "@/components/ui/integration-status";
import { apiPost } from "@/lib/api";
import { useDkgGraph, type DkgAsset, type DkgHealth } from "@/lib/use-dkg-graph";

const EXAMPLE_QUERY = `PREFIX pf: <https://permitframe.app/ns#>
SELECT ?passport ?status ?validUntil WHERE { ?passport a pf:PermitFramePermissionPassport ; pf:status ?status ; pf:validUntil ?validUntil . }`;

/** Binding values may be RDF term objects like { value: "..." } — unwrap them. */
function cellValue(v: unknown): string {
  if (v !== null && typeof v === "object" && "value" in (v as Record<string, unknown>)) {
    const inner = (v as Record<string, unknown>).value;
    if (inner !== undefined && inner !== null) return String(inner);
  }
  return String(v);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

type QueryState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "ready"; bindings: Array<Record<string, unknown>>; columns: string[]; ms: number }
  | { status: "failed"; error: string; ms: number };

export default function GraphPage() {
  const uid = useId();
  // Slow DKG reads live under the separate ["dkg-graph"] key — never in the
  // workspace snapshot, never blocking app navigation. The last known health
  // and asset list render immediately from cache and refresh in the
  // background; the shell, explanation, and query editor below always render.
  const graph = useDkgGraph();
  const health: DkgHealth | null = graph.data?.health ?? null;
  const assets: DkgAsset[] = graph.data?.assets ?? [];
  const loadError = !graph.data && graph.isError
    ? (graph.error instanceof Error ? graph.error.message : "Proof records failed to load.")
    : null;

  const [query, setQuery] = useState(EXAMPLE_QUERY);
  const [queryState, setQueryState] = useState<QueryState>({ status: "idle" });
  const [copied, setCopied] = useState(false);

  async function runQuery() {
    if (!query.trim() || queryState.status === "running") return;
    setQueryState({ status: "running" });
    setCopied(false);
    const started = performance.now();
    try {
      const data = await apiPost<{ bindings?: Array<Record<string, unknown>> }>("/api/dkg", { query });
      const bindings = data.bindings ?? [];
      const columns = Array.from(new Set(bindings.flatMap((b) => Object.keys(b)))).filter((k) => k !== "raw");
      setQueryState({ status: "ready", bindings, columns, ms: Math.round(performance.now() - started) });
    } catch (e) {
      setQueryState({
        status: "failed",
        error: e instanceof Error ? e.message : "Query failed.",
        ms: Math.round(performance.now() - started)
      });
    }
  }

  async function copyResults() {
    if (queryState.status !== "ready") return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(queryState.bindings, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  const running = queryState.status === "running";
  const textareaId = `${uid}-sparql`;

  return (
    <div className="pf-page space-y-8">
      <Link href="/verifier" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-emerald-700 hover:underline dark:text-emerald-300">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Back to Verification
      </Link>
      <PageHeader
        eyebrow="Verification · Advanced"
        title="Proof inspector"
        description="A technical view of the underlying proof records behind campaigns, permissions, and brand rules. Most producers never need this — Verification covers day-to-day review."
      />

      {loadError && <ErrorState message={loadError} onRetry={() => { void graph.refetch(); }} />}

      {!health && !loadError && <LoadingSkeleton rows={1} />}

      {health && (
        <SectionCard>
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <HealthDot healthy={health.healthy} />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                DKG: {health.mode === "edge-node" ? `V10 Edge Node${health.blockchain ? ` (${health.blockchain})` : ""}` : "local evidence mode"}
              </p>
              <p className="mt-0.5 break-words text-xs text-muted-foreground">{health.detail}</p>
              {health.mode === "local-evidence" && (
                <p className="mt-1.5 break-words text-xs leading-relaxed text-muted-foreground">
                  Honest note: this table lists what the local evidence store can read back. Passport or
                  fact identifiers shown on other screens are stored references — if this list is empty while
                  references exist elsewhere, the store file was cleared or a different data directory is in
                  use. Nothing here is fabricated.
                </p>
              )}
              {health.mode === "edge-node" && (
                <p className="mt-1.5 break-words text-xs leading-relaxed text-muted-foreground">
                  Honest note: results come from live Shared Working Memory. An empty list means the context
                  graph holds no matching assets yet — identifiers elsewhere are stored references, not live
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
            Cached records are never decision truth — permission checks, publishing, renewal, revocation, and approval always query live.
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
                {a.explorerUrl ? (
                  <a
                    href={a.explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-block text-xs font-medium text-emerald-700 hover:text-emerald-600 dark:text-emerald-300 dark:hover:text-emerald-200"
                  >
                    explorer →
                  </a>
                ) : (
                  <p className="mt-3 text-[11px] text-muted-foreground">Working Memory only — no explorer anchor yet.</p>
                )}
              </article>
            );
          })}
          {health && assets.length === 0 && !loadError && (
            <EmptyState title="No proof records readable" body="Either nothing has been recorded yet, or the proof store differs from the workspace database. Identifiers on other screens are stored references — this list only shows live reads." />
          )}
        </div>
      </section>

      <SectionCard
        title="SPARQL console"
        description={
          health?.mode === "local-evidence"
            ? "Local evidence mode answers the passport/facts query shapes; anything else returns zero rows — that is a stated limit, not a failure."
            : "Queries run live against the DKG. Slow or empty answers are reported as-is."
        }
      >
        <Label htmlFor={textareaId} className="text-[12px] text-muted-foreground">Query</Label>
        <textarea
          id={textareaId}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          rows={5}
          spellCheck={false}
          className="mt-1.5 w-full rounded-lg border border-border bg-muted/50 p-4 font-mono text-xs leading-relaxed text-foreground focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 dark:bg-muted/30"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            onClick={runQuery}
            disabled={running || !query.trim()}
            aria-busy={running}
            title={!query.trim() ? "Write a query to enable Run" : undefined}
            className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-emerald-50 hover:bg-emerald-600 disabled:opacity-50 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
          >
            {running ? "Running…" : "Run query"}
          </Button>
          {queryState.status === "ready" && (
            <>
              <span role="status" className="font-mono text-[11px] text-muted-foreground">
                {queryState.bindings.length} {queryState.bindings.length === 1 ? "row" : "rows"} · {queryState.ms} ms
              </span>
              {queryState.bindings.length > 0 && (
                <Button variant="ghost" size="sm" onClick={copyResults} className="h-7 rounded-full px-2.5 text-[11.5px]" aria-label="Copy query results as JSON">
                  {copied ? <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                  {copied ? "Copied" : "Copy JSON"}
                </Button>
              )}
            </>
          )}
          {queryState.status === "failed" && (
            <span role="alert" className="break-words font-mono text-[11px] text-rose-600 dark:text-rose-300">
              Failed after {queryState.ms} ms: {queryState.error}
            </span>
          )}
        </div>

        {queryState.status === "ready" && (
          <div className="mt-5 overflow-x-auto rounded-xl border border-border bg-muted/40">
            {queryState.columns.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">0 bindings returned — the query ran fine, it just matched nothing.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <caption className="sr-only">SPARQL query results</caption>
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                    {queryState.columns.map((col) => (
                      <th key={col} scope="col" className="px-3 py-2 font-medium">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {queryState.bindings.map((binding, i) => (
                    <tr key={i}>
                      {queryState.columns.map((col) => (
                        <td key={col} className="max-w-64 break-all px-3 py-2 font-mono text-xs text-foreground/80">
                          {cellValue(binding[col])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
        {queryState.status === "idle" && (
          <p className="mt-5 text-sm text-muted-foreground">Run a query to inspect the proof records.</p>
        )}
      </SectionCard>
    </div>
  );
}
