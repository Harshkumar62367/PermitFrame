"use client";

import { useEffect, useState } from "react";

interface DkgHealth {
  mode: string;
  healthy: boolean;
  endpoint?: string;
  blockchain?: string;
  detail: string;
}

interface DkgAsset {
  ual: string;
  explorerUrl: string;
  name: string;
  content: Record<string, unknown>;
  publishedAt: string;
  mode: string;
}

interface DkgGetResponse {
  health: DkgHealth;
  assets: DkgAsset[];
}

interface DkgPostResponse {
  bindings?: Array<Record<string, unknown>>;
  mode?: string;
  error?: string;
}

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

export default function GraphPage() {
  const [health, setHealth] = useState<DkgHealth | null>(null);
  const [assets, setAssets] = useState<DkgAsset[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState(EXAMPLE_QUERY);
  const [bindings, setBindings] = useState<Array<Record<string, unknown>> | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    fetch("/api/dkg")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`DKG request failed (${r.status})`))))
      .then((data: DkgGetResponse) => {
        setHealth(data.health);
        setAssets(data.assets ?? []);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  async function runQuery() {
    setRunning(true);
    setQueryError(null);
    setBindings(null);
    try {
      const r = await fetch("/api/dkg", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query })
      });
      const data = (await r.json()) as DkgPostResponse;
      if (!r.ok || data.error) throw new Error(data.error ?? `Query failed (${r.status})`);
      setBindings(data.bindings ?? []);
    } catch (e) {
      setQueryError(String((e as Error).message ?? e));
    } finally {
      setRunning(false);
    }
  }

  const columns =
    bindings === null
      ? []
      : Array.from(new Set(bindings.flatMap((b) => Object.keys(b)))).filter((k) => k !== "raw");

  return (
    <div className="space-y-8">
      <section>
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Knowledge graph{" "}
          <span className="text-emerald-600 dark:text-emerald-300">— the DKG behind every decision</span>
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          Permission passports, verified product facts and derivative receipts are published to the OriginTrail
          DKG as Knowledge Assets. Every preflight decision and every generated frame traces back to these records.
        </p>
      </section>

      {error && (
        <p className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">{error}</p>
      )}

      {!health && !error && <p className="text-sm text-muted-foreground/80">Loading knowledge graph…</p>}

      {health && (
        <section className="rounded-2xl border border-border bg-card p-6">
          <div className="flex flex-wrap items-center gap-3">
            <span className={`h-2.5 w-2.5 rounded-full ${health.healthy ? "bg-emerald-400" : "bg-rose-400"}`} />
            <div>
              <p className="text-sm font-medium text-foreground">
                DKG: {health.mode === "dkg-testnet" ? `testnet${health.blockchain ? ` (${health.blockchain})` : ""}` : "local evidence mode"}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground/80">{health.detail}</p>
            </div>
          </div>
        </section>
      )}

      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Knowledge Assets</h2>
          <span className="text-xs text-muted-foreground/80">{assets.length} published</span>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {assets.map((a) => {
            const type = typeof a.content["@type"] === "string" ? (a.content["@type"] as string) : "";
            return (
              <article key={a.ual} className="rounded-xl border border-border bg-card p-5">
                <div className="flex items-center justify-between gap-3">
                  {type ? (
                    <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-700/40">
                      {type}
                    </span>
                  ) : (
                    <span />
                  )}
                  <span className="text-xs text-muted-foreground/80">{formatDate(a.publishedAt)}</span>
                </div>
                <h3 className="mt-3 font-medium text-foreground">{a.name}</h3>
                <p className="mt-2 truncate font-mono text-xs text-muted-foreground/80" title={a.ual}>
                  {a.ual}
                </p>
                {a.explorerUrl && (
                  <a
                    href={a.explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-block text-xs font-medium text-emerald-700 hover:text-emerald-600 dark:text-emerald-300 dark:hover:text-emerald-200"
                  >
                    explorer →
                  </a>
                )}
              </article>
            );
          })}
          {health && assets.length === 0 && <p className="text-sm text-muted-foreground/80">No Knowledge Assets published yet.</p>}
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">SPARQL console</h2>
        {health?.mode === "local-evidence" && (
          <p className="mt-2 text-xs text-muted-foreground/80">
            Local evidence mode: arbitrary SPARQL executes against the public DKG only when DKG_MODE=real.
          </p>
        )}
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          rows={5}
          spellCheck={false}
          className="mt-4 w-full rounded-lg border border-border bg-muted/50 p-4 font-mono text-xs leading-relaxed text-foreground focus:border-emerald-500/50 dark:bg-muted/30 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={runQuery}
            disabled={running || !query.trim()}
            className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            {running ? "Running…" : "Run query"}
          </button>
          {queryError && <p className="text-xs text-rose-300">{queryError}</p>}
        </div>

        {bindings !== null && (
          <div className="mt-5 overflow-x-auto rounded-xl border border-border bg-muted/40">
            {columns.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground/80">0 bindings returned.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground/80">
                    {columns.map((col) => (
                      <th key={col} className="px-3 py-2 font-medium">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {bindings.map((binding, i) => (
                    <tr key={i}>
                      {columns.map((col) => (
                        <td key={col} className="px-3 py-2 font-mono text-xs break-all text-foreground/80">
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
        {bindings === null && !queryError && (
          <p className="mt-5 text-sm text-muted-foreground/80">Run a query to inspect the graph.</p>
        )}
      </section>
    </div>
  );
}
