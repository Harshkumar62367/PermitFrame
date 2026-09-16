/**
 * Control-room loading state: exact geometry of the final layout (header,
 * four-metric strip, two priority panels, pipeline, activity) so content
 * swaps in without layout shift. Decorative blocks are aria-hidden; a single
 * sr-only status announces.
 */
export function WorkspaceOverviewSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-6">
      {/* Header shape: eyebrow + title + description + action */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="h-3 w-32 rounded bg-muted" />
          <div className="mt-3 h-9 w-64 rounded-lg bg-muted" />
          <div className="mt-3 h-4 w-80 max-w-full rounded bg-muted" />
        </div>
        <div className="h-9 w-36 shrink-0 rounded-full bg-muted" />
      </div>

      {/* Four-metric strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-2xl border border-border bg-card px-4 py-3.5">
            <div className="flex items-center justify-between">
              <div className="h-3 w-24 rounded bg-muted" />
              <div className="h-4 w-4 rounded bg-muted" />
            </div>
            <div className="mt-2 h-7 w-16 rounded-lg bg-muted" />
            <div className="mt-1.5 h-3 w-28 rounded bg-muted" />
          </div>
        ))}
      </div>

      {/* Two priority panels with thumbnails */}
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="overflow-hidden rounded-2xl border border-border bg-card">
            <div className="h-3.5 border-b border-border bg-muted/60" />
            <div className="aspect-video w-full bg-muted/60" />
            <div className="p-5">
              <div className="flex items-center gap-2">
                <div className="h-6 w-20 rounded-full bg-muted" />
                <div className="h-3 w-28 rounded bg-muted" />
              </div>
              <div className="mt-3 h-5 w-3/4 rounded bg-muted" />
              <div className="mt-2 h-3.5 w-1/2 rounded bg-muted" />
              <div className="mt-4 space-y-2">
                <div className="h-12 w-full rounded-xl bg-muted/70" />
                <div className="h-12 w-full rounded-xl bg-muted/70" />
              </div>
              <div className="mt-4 flex gap-2">
                <div className="h-9 w-36 rounded-full bg-muted" />
                <div className="h-9 w-28 rounded-full bg-muted" />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Pipeline */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center justify-between">
          <div className="h-5 w-40 rounded bg-muted" />
          <div className="h-3.5 w-32 rounded bg-muted" />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-xl bg-muted/50 px-3.5 py-3 ring-1 ring-border">
              <div className="h-3.5 w-20 rounded bg-muted" />
              <div className="mt-2 h-7 w-10 rounded bg-muted" />
            </div>
          ))}
        </div>
      </div>

      {/* Activity */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="h-5 w-32 rounded bg-muted" />
        <div className="mt-3 space-y-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 px-2 py-2.5">
              <div className="h-8 w-8 shrink-0 rounded-full bg-muted" />
              <div className="min-w-0 flex-1">
                <div className="h-3.5 w-2/3 rounded bg-muted" />
                <div className="mt-1.5 h-3 w-full rounded bg-muted/70" />
              </div>
              <div className="h-3 w-16 shrink-0 rounded bg-muted" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Screen-reader loading announcement, rendered alongside the skeleton. */
export function OverviewLoadingStatus() {
  return (
    <span role="status" className="sr-only">
      Loading campaign control room…
    </span>
  );
}
