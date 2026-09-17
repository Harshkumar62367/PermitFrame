"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { ArrowRight, Link2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FadeIn, Stagger, StaggerItem } from "@/components/motion-primitives";
import { PageHeader } from "@/components/ui/page-header";
import { SectionCard } from "@/components/ui/section-card";
import { CopyableIdentifier } from "@/components/ui/identifier";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { apiPost, describeRecord } from "@/lib/api";
import { useInvalidateDkgGraph } from "@/lib/use-dkg-graph";
import { useInvalidateWorkspaceSnapshot, useWorkspaceSnapshot, type SnapshotCampaign } from "@/lib/use-workspace-snapshot";
import { cn } from "@/lib/utils";
import type { SourceMedia } from "@/server/types";

const EXAMPLE_FORM = { title: "Maya - rooftop vertical", url: "https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?w=1200&q=80&fm=jpg", type: "image" };

export default function MediaLibraryPage() {
  const uid = useId();
  // Source media reads from the shared ["workspace-snapshot"] cache: cached
  // rows render instantly and stay visible during background refetches. An
  // inline skeleton shows only when no cached snapshot exists at all.
  const snapshot = useWorkspaceSnapshot();
  const media = snapshot.data?.sourceMedia ?? null;
  const loadError = !snapshot.data && snapshot.isError
    ? (snapshot.error instanceof Error ? snapshot.error.message : "Media library failed to load.")
    : null;
  const [form, setForm] = useState({ title: "", url: "", type: "image" });
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; ual?: string } | null>(null);
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();
  const invalidateDkgGraph = useInvalidateDkgGraph();

  function fillExample() {
    setForm(EXAMPLE_FORM);
    setFieldError(null);
    setResult(null);
  }

  async function register() {
    if (busy) return;
    if (!form.url.trim().toLowerCase().startsWith("http")) {
      setFieldError("Paste a public http(s) URL — the bytes stay with the creator; only the URL and hash are recorded.");
      return;
    }
    setFieldError(null);
    setResult(null);
    setBusy(true);
    try {
      const j = await apiPost<{ media: SourceMedia }>("/api/media", {
        title: form.title,
        url: form.url.trim(),
        type: form.type
      });
      const record = describeRecord(j.media.ual);
      setResult({
        ok: true,
        text: `${record.headline} — “${j.media.title}”. ${record.detail}`,
        ual: j.media.ual
      });
      setForm({ title: "", url: "", type: "image" });
      // Registration publishes a Knowledge Asset: refresh the shared snapshot
      // (awaited, so the new row appears) and mark the cached graph stale.
      await invalidateSnapshot();
      invalidateDkgGraph();
    } catch (e) {
      // Form input is preserved for retry.
      setResult({ ok: false, text: e instanceof Error ? e.message : "Registration failed. Your input is preserved." });
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = form.url.trim().toLowerCase().startsWith("http");
  const urlId = `${uid}-url`;
  const submitHint = `${uid}-submit-hint`;

  return (
    <div className="pf-page space-y-6">
      <FadeIn>
        <PageHeader
          eyebrow="Media library"
          title="Media library"
          description="Source images and video, plus generated campaign assets. Only the reference and a checksum are stored — the files stay with the creator."
        />
      </FadeIn>

      <FadeIn delay={0.05}>
        <SectionCard
          title="Register a source asset"
          description="Guided scenario — every field starts empty; grey placeholder text is only an example, never a value."
          actions={
            <Button variant="outline" size="sm" onClick={fillExample} className="h-7 rounded-full px-2.5 text-[11.5px]">
              <Wand2 className="h-3 w-3" aria-hidden /> Fill guided example
            </Button>
          }
        >
          <div className="grid gap-4 sm:grid-cols-[1fr_2fr_140px_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-title`} className="text-[12px] text-muted-foreground">Title</Label>
              <Input
                id={`${uid}-title`}
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="Maya - rooftop vertical"
                className="rounded-xl placeholder:italic placeholder:text-muted-foreground/50"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={urlId} className="text-[12px] text-muted-foreground">Public URL (https)</Label>
              <Input
                id={urlId}
                value={form.url}
                aria-invalid={Boolean(fieldError)}
                aria-describedby={fieldError ? `${urlId}-error` : undefined}
                onChange={(e) => {
                  setForm((f) => ({ ...f, url: e.target.value }));
                  setFieldError(null);
                }}
                placeholder="https://…"
                className={cn("rounded-xl font-mono text-[12px] placeholder:italic placeholder:text-muted-foreground/50", fieldError && "border-rose-500")}
              />
              {fieldError && <p id={`${urlId}-error`} role="alert" className="text-[12px] text-rose-600 dark:text-rose-300">{fieldError}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-type`} className="text-[12px] text-muted-foreground">Type</Label>
              <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v }))}>
                <SelectTrigger id={`${uid}-type`} className="w-full rounded-xl"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="image">image</SelectItem>
                  <SelectItem value="video">video</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={register}
              disabled={busy || !canSubmit}
              aria-busy={busy}
              aria-describedby={submitHint}
              title={!canSubmit ? "Paste a public http(s) URL to enable registration" : undefined}
              className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
            >
              <Link2 className="h-4 w-4" aria-hidden /> {busy ? "Registering…" : "Register"}
            </Button>
          </div>
          <p id={submitHint} className="mt-2 text-[11.5px] text-muted-foreground">
            {!canSubmit
              ? "Register is disabled until a public URL is pasted — placeholders don't count."
              : busy
                ? "Registering — duplicate clicks are ignored and your input is preserved on failure."
                : "Only the URL and its content hash enter the evidence layer."}
          </p>
          {result && (
            <div
              role={result.ok ? "status" : "alert"}
              className={cn(
                "mt-3 rounded-xl px-4 py-3 text-[13px] ring-1",
                result.ok
                  ? "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900"
                  : "bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900"
              )}
            >
              <p>{result.text}</p>
            </div>
          )}
        </SectionCard>
      </FadeIn>

      {loadError && <ErrorState message={loadError} onRetry={() => { void snapshot.refetch(); }} />}
      {!media && !loadError && <LoadingSkeleton rows={3} />}
      <section aria-label="Approved source media">
        <h2 className="mb-1 text-[15px] font-semibold tracking-tight">Approved source media</h2>
        <p className="mb-3 text-[12px] text-muted-foreground">
          Registered inputs for generation — only the reference and a checksum are stored.
        </p>
      <Stagger className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(media ?? []).map((m) => (
          <StaggerItem key={m.id}>
            <div className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card">
              {m.type === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={m.url} alt={m.title} className="aspect-video w-full object-cover" loading="lazy" />
              ) : (
                <video src={m.url} className="aspect-video w-full bg-black object-contain" controls preload="metadata" />
              )}
              <div className="min-w-0 p-4">
                <p className="text-[13.5px] font-medium leading-snug">{m.title}</p>
                <CopyableIdentifier value={m.id} className="mt-1 max-w-full text-[10.5px]" />
                <p className="mt-0.5 break-all font-mono text-[10px] text-muted-foreground" title={`checksum ${m.hash}`}>
                  checksum {m.hash.slice(0, 24)}…
                </p>
              </div>
            </div>
          </StaggerItem>
        ))}
      </Stagger>
      </section>
      {media && media.length === 0 && !loadError && (
        <EmptyState
          title="No media yet"
          body="Register the first approved asset above, then brief a campaign — the permission check runs automatically before anything is produced."
        />
      )}
      {media && media.length > 0 && (
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          Provenance note: records are keyed by stable IDs, so registering the same URL twice creates two
          separate records. PermitFrame never deletes or merges them — newest first is just display order.
        </p>
      )}
      <GeneratedOutputs campaigns={snapshot.data?.campaigns ?? null} />
    </div>
  );
}

/**
 * Generated campaign outputs, kept visually separate from approved source
 * media. Finished assets live with their campaigns — this section links
 * each pack back to its studio. Read from the shared snapshot, so no
 * per-campaign reads and nothing fabricated.
 */
function GeneratedOutputs({ campaigns }: { campaigns: SnapshotCampaign[] | null }) {
  if (campaigns === null) return null;
  const produced = campaigns.filter((c) => c.receiptsCount > 0);
  return (
    <section aria-label="Generated campaign outputs" className="mt-2">
      <h2 className="mb-1 text-[15px] font-semibold tracking-tight">Generated campaign outputs</h2>
      <p className="mb-3 text-[12px] text-muted-foreground">
        Finished assets belong to their campaigns — open a pack to review, approve, and verify each output.
      </p>
      {produced.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-[12.5px] text-muted-foreground">
          No generated outputs yet. Brief a campaign, pass the permission check, and generate the pack.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {produced.map((c) => (
            <Link
              key={c.id}
              href={`/campaigns/${c.id}`}
              className="group min-w-0 overflow-hidden rounded-2xl border border-border bg-card transition hover:border-emerald-600/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
            >
              {c.generatedUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.generatedUrl} alt={c.title} loading="lazy" className="aspect-video w-full object-cover" />
              ) : (
                <span className="grid aspect-video w-full place-items-center bg-muted font-mono text-[11px] text-muted-foreground">
                  video pack
                </span>
              )}
              <span className="flex items-center gap-2 p-4">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium leading-snug">{c.title}</span>
                  <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                    {c.receiptsCount} output{c.receiptsCount === 1 ? "" : "s"}
                  </span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-emerald-700 dark:text-emerald-300">
                  Open pack <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
