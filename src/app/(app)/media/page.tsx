"use client";

import Link from "next/link";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowRight, Link2, Lock, Upload, Wand2 } from "lucide-react";
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
import { MEDIA_TABS, nextMediaTab, type MediaTab } from "@/lib/media-tabs";
import { classifyUploadError, shouldReconcileAfterUploadFailure, uploadCancelledNote, type UploadProgress } from "@/lib/upload-progress";
import { postUpload } from "@/lib/upload-request";
import { useLongAction } from "@/lib/use-long-action";
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
  const creators = snapshot.data?.creators ?? null;
  const loadError = !snapshot.data && snapshot.isError
    ? (snapshot.error instanceof Error ? snapshot.error.message : "Media library failed to load.")
    : null;
  const [form, setForm] = useState({ title: "", url: "", type: "image" });
  // Explicit creator selection only - the server rejects registration
  // without one, so this starts empty and is never auto-filled. Shared by
  // both tabs: every asset, uploaded or referenced, belongs to a creator.
  const [creatorId, setCreatorId] = useState("");
  const [tab, setTab] = useState<MediaTab>("upload");
  // Roving focus for the tablist: arrow-key activation moves focus to the
  // newly selected tab, so keyboard users never lose their place.
  const tabButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  // Synchronous phase mirror: React state lags, but cancel honesty needs
  // to know whether bytes already left the browser at abort time.
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const phaseRef = useRef<"idle" | "uploading" | "processing">("idle");
  const [fieldError, setFieldError] = useState<string | null>(null);
  // Minimal creator onboarding: name + optional handle, created in this
  // workspace. A creator record is a label for who appears - it performs
  // no identity check; only a consent link creates a permission.
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [creatorName, setCreatorName] = useState("");
  const [creatorHandle, setCreatorHandle] = useState("");
  const [creatorError, setCreatorError] = useState<string | null>(null);
  const [creatorBusy, setCreatorBusy] = useState(false);
  const registerAction = useLongAction({
    working: "Registering source asset…",
    slow: "Still registering and recording the source asset. Please keep this page open - proof services can take a little longer.",
    timedOut:
      "Registration is taking longer than expected. Refresh this page once before retrying - the asset may already have been registered."
  });
  const busy = registerAction.busy;
  const [result, setResult] = useState<{ ok: boolean; text: string; ual?: string } | null>(null);
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();
  const invalidateDkgGraph = useInvalidateDkgGraph();

  function fillExample() {
    selectTab("url");
    setForm(EXAMPLE_FORM);
    setFieldError(null);
    setResult(null);
  }

  /**
   * Single tab-switch path for clicks, keys, and the guided example. Leaving
   * the upload tab while a computer-file upload is active aborts the live
   * XHR - a browser upload must never keep running silently behind the URL
   * panel. The abort settles through upload()'s catch/finally, which posts
   * the same honest cancellation notice and preserves creator, title, and
   * file for a deliberate retry. URL registration owns no XHR and is
   * untouched by tab changes.
   */
  function selectTab(next: MediaTab) {
    if (next === tab) return;
    if (tab === "upload" && next === "url" && uploadBusy && xhrRef.current) {
      try {
        xhrRef.current.abort();
      } catch {
        // Fall through to the request's own error/timeout settlement.
      }
    }
    setTab(next);
  }

  function onTablistKeyDown(e: KeyboardEvent) {
    const next = nextMediaTab(tab, e.key);
    if (!next) return;
    e.preventDefault();
    selectTab(next);
    tabButtonRefs.current[MEDIA_TABS.indexOf(next)]?.focus();
  }

  async function upload() {
    if (uploadBusy) return;
    if (!creatorId) {
      setUploadError("Choose the creator this asset belongs to - or add them below first.");
      return;
    }
    if (!uploadFile) {
      setUploadError("Choose a file from your computer first.");
      return;
    }
    if (uploadFile.size === 0) {
      setUploadError("The selected file is empty - choose a file with content.");
      return;
    }
    if (uploadFile.size > 25 * 1024 * 1024) {
      setUploadError("That file is too large to upload - images up to 10 MB and videos up to 25 MB can be uploaded.");
      return;
    }
    setUploadBusy(true);
    setUploadError(null);
    setUploadNote(null);
    setResult(null);
    phaseRef.current = "uploading";
    setUploadProgress({ phase: "uploading", pct: 0 });
    try {
      const formData = new FormData();
      formData.set("file", uploadFile, uploadFile.name);
      formData.set("creatorId", creatorId);
      formData.set("title", uploadTitle.trim());
      const { media } = await postUpload(formData, {
        onProgress: setUploadProgress,
        onSent: () => {
          phaseRef.current = "processing";
          setUploadProgress({ phase: "processing", pct: null });
        },
        track: (xhr) => {
          xhrRef.current = xhr;
        },
        phase: () => (phaseRef.current === "processing" ? "processing" : "uploading")
      });
      const record = describeRecord(media.ual);
      setResult({
        ok: true,
        text: `${record.headline} - “${media.title}” (private workspace copy). ${record.detail}`,
        ual: media.ual
      });
      setUploadFile(null);
      setUploadTitle("");
      await invalidateSnapshot();
      invalidateDkgGraph();
    } catch (e) {
      const outcome = classifyUploadError(e);
      if (outcome.kind === "cancelled") {
        // Cancellation is a note, never a failure and never a success:
        // the abort already settled the request exactly once, and
        // busy/progress cleanup runs in finally below. Processing-phase
        // cancels reconcile because server-side registration may still
        // finish - the note says to refresh the gallery before retrying.
        // Creator, title, and file state are preserved for a deliberate
        // retry; only busy/progress reset.
        if (outcome.phase === "processing") {
          await invalidateSnapshot().catch(() => undefined);
        }
        setUploadNote(uploadCancelledNote(outcome.phase));
      } else if (shouldReconcileAfterUploadFailure(outcome.status)) {
        // Unknown outcome (timeout, network loss, server hiccup): the
        // server may still finish registering, so re-read the library to
        // show the final state instead of guessing.
        await invalidateSnapshot().catch(() => undefined);
        setUploadError(
          e instanceof Error
            ? `${e.message} Check the library below to see whether the asset registered before retrying.`
            : "Upload outcome unknown. Check the library below to see whether the asset registered before retrying."
        );
      } else {
        setUploadError(e instanceof Error ? e.message : "Upload failed. Your file was not registered.");
      }
    } finally {
      xhrRef.current = null;
      phaseRef.current = "idle";
      setUploadBusy(false);
      setUploadProgress(null);
    }
  }

  function cancelUpload() {
    const xhr = xhrRef.current;
    if (!xhr || !uploadBusy) return;
    // Abort only: the onabort handler settles the request exactly once and
    // the catch/finally above owns all messaging and cleanup, so nothing
    // here may touch busy/progress state (that would double-update it).
    // If abort itself throws, the pending handlers still settle the
    // request through their normal paths.
    try {
      xhr.abort();
    } catch {
      // Fall through to the request's own error/timeout settlement.
    }
  }

  async function register() {
    // A tab switch aborts an upload asynchronously. Until its abort handler
    // settles, do not permit a second source-media mutation from the URL tab.
    if (registerAction.busy || uploadBusy) return;
    if (!creatorId) {
      setFieldError("Choose the creator this asset belongs to - or add them below first.");
      return;
    }
    if (!form.url.trim().toLowerCase().startsWith("http")) {
      setFieldError("Paste a public http(s) URL - the bytes stay with the creator; only the URL and hash are recorded.");
      return;
    }
    setFieldError(null);
    setResult(null);
    // Registration publishes a Knowledge Asset, so it can legitimately
    // outlast the default 30s browser budget - 120s with slow status and
    // refresh-first recovery. Input is preserved for retry either way.
    const result = await registerAction.execute(() =>
      apiPost<{ media: SourceMedia }>("/api/media", {
        creatorId,
        title: form.title,
        url: form.url.trim(),
        type: form.type
      }, undefined, registerAction.timeoutMs)
    );
    if (!result.ok || !result.value) {
      if (result.message) setResult({ ok: false, text: result.message });
      return;
    }
    const j = result.value;
      const record = describeRecord(j.media.ual);
      setResult({
        ok: true,
        text: `${record.headline} - “${j.media.title}”. ${record.detail}`,
        ual: j.media.ual
      });
      setForm({ title: "", url: "", type: "image" });
      // Registration publishes a Knowledge Asset: refresh the shared snapshot
      // (awaited, so the new row appears) and mark the cached graph stale.
      await invalidateSnapshot();
      invalidateDkgGraph();
  }

  async function addCreator() {
    if (creatorBusy) return;
    if (!creatorName.trim()) {
      setCreatorError("Give the creator a name so media and requests can attach to them.");
      return;
    }
    setCreatorBusy(true);
    setCreatorError(null);
    try {
      const j = await apiPost<{ creator: { id: string; name: string; handle: string } }>("/api/creators", {
        name: creatorName.trim(),
        handle: creatorHandle.trim()
      });
      setCreatorName("");
      setCreatorHandle("");
      setCreatorOpen(false);
      // The user just created this creator explicitly - select it.
      setCreatorId(j.creator.id);
      setFieldError(null);
      await invalidateSnapshot();
    } catch (e) {
      setCreatorError(e instanceof Error ? e.message : "Creator creation failed. Your input is preserved.");
    } finally {
      setCreatorBusy(false);
    }
  }

  const canSubmit = creatorId !== "" && form.url.trim().toLowerCase().startsWith("http");
  const urlId = `${uid}-url`;
  const submitHint = `${uid}-submit-hint`;

  return (
    <div className="pf-page space-y-6">
      <FadeIn>
        <PageHeader
          eyebrow="Media library"
          title="Media library"
          description="Source images and video, plus generated campaign assets. URL references record only the reference and its fingerprint - the files stay with the creator. Uploads are stored as private workspace copies instead."
        />
      </FadeIn>

      <FadeIn delay={0.05}>
        <SectionCard
          title="Register a source asset"
          description="Guided scenario - every field starts empty; grey placeholder text is only an example, never a value."
          actions={
            <Button variant="outline" size="sm" onClick={fillExample} className="h-7 rounded-full px-2.5 text-[11.5px]">
              <Wand2 className="h-3 w-3" aria-hidden /> Fill guided example
            </Button>
          }
        >
          <div className="max-w-md space-y-1.5">
              <Label htmlFor={`${uid}-creator`} className="text-[12px] text-muted-foreground">Creator (required)</Label>
              <Select value={creatorId} onValueChange={(v) => { setCreatorId(v === "__none" ? "" : v); setFieldError(null); setUploadError(null); }}>
                <SelectTrigger id={`${uid}-creator`} className="w-full rounded-xl">
                  <SelectValue placeholder={creators === null ? "Loading…" : creators.length === 0 ? "No creators yet - add one below" : "Choose a creator"} />
                </SelectTrigger>
                <SelectContent>
                  {(creators ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}{c.handle ? ` (${c.handle})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          <div className="mt-4 flex gap-1 rounded-full bg-muted p-1 ring-1 ring-border" role="tablist" aria-label="How to add source media" onKeyDown={onTablistKeyDown}>
            <button
              type="button"
              role="tab"
              id={`${uid}-tab-upload`}
              aria-selected={tab === "upload"}
              aria-controls={`${uid}-panel-upload`}
              tabIndex={tab === "upload" ? 0 : -1}
              ref={(el) => { tabButtonRefs.current[0] = el; }}
              onClick={() => selectTab("upload")}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-medium transition",
                tab === "upload" ? "bg-card text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Upload className="h-3.5 w-3.5" aria-hidden /> Upload from computer
              <span className="rounded-full bg-emerald-600/10 px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300">recommended</span>
            </button>
            <button
              type="button"
              role="tab"
              id={`${uid}-tab-url`}
              aria-selected={tab === "url"}
              aria-controls={`${uid}-panel-url`}
              tabIndex={tab === "url" ? 0 : -1}
              ref={(el) => { tabButtonRefs.current[1] = el; }}
              onClick={() => selectTab("url")}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-medium transition",
                tab === "url" ? "bg-card text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Link2 className="h-3.5 w-3.5" aria-hidden /> Use public URL
            </button>
          </div>
          {tab === "upload" && (
          <div className="mt-4" role="tabpanel" id={`${uid}-panel-upload`} aria-labelledby={`${uid}-tab-upload`} tabIndex={0}>
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Uploaded originals are stored as a <span className="font-medium text-foreground">private workspace copy</span> with
              restricted delivery - never as public proof. Only a time-limited download link (expires one hour after
              creation) is shared with the production service when you generate; uploads never appear in public shares
              or verification pages, and uploaded originals have no public preview.
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-file`} className="text-[12px] text-muted-foreground">1. Select a file (image up to 10 MB, video up to 25 MB)</Label>
                <Input
                  id={`${uid}-file`}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime,.mov"
                  onChange={(e) => { setUploadFile(e.target.files?.[0] ?? null); setUploadError(null); }}
                  className="sr-only"
                />
                <label
                  htmlFor={`${uid}-file`}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-dashed border-border bg-muted/35 px-3 text-[13px] font-medium text-foreground transition hover:border-emerald-600/50 hover:bg-emerald-600/5 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2"
                >
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-700 px-3 py-1.5 text-[12px] font-medium text-emerald-50 dark:bg-emerald-500 dark:text-emerald-950">
                    <Upload className="h-3.5 w-3.5" aria-hidden /> Choose file
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground">
                    {uploadFile ? uploadFile.name : "No file selected"}
                  </span>
                </label>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-upload-title`} className="text-[12px] text-muted-foreground">Title (optional)</Label>
                <Input
                  id={`${uid}-upload-title`}
                  value={uploadTitle}
                  onChange={(e) => { setUploadTitle(e.target.value); setUploadError(null); }}
                  placeholder="Maya - rooftop vertical"
                  className="rounded-xl placeholder:italic placeholder:text-muted-foreground/50"
                />
              </div>
              <div className="flex gap-2">
              <Button
                onClick={upload}
                disabled={uploadBusy || !uploadFile || !creatorId}
                aria-busy={uploadBusy}
                title={!creatorId ? "Choose a creator first" : !uploadFile ? "Choose a file first" : undefined}
                className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
              >
                <Upload className="h-4 w-4" aria-hidden />{" "}
                {uploadBusy
                  ? uploadProgress?.phase === "processing"
                    ? "Securing…"
                    : `Uploading ${uploadProgress?.pct ?? 0}%…`
                  : "Upload file"}
              </Button>
              {uploadBusy && (
                <Button variant="outline" onClick={cancelUpload} aria-label="Cancel the in-progress upload" className="rounded-full">
                  Cancel upload
                </Button>
              )}
              </div>
            </div>
            {uploadFile && !uploadBusy && (
              <p role="status" className="mt-2 text-[12px] text-muted-foreground">
                Selected: <span className="font-medium text-foreground">{uploadFile.name}</span>
                {" "}({(uploadFile.size / 1048576).toFixed(1)} MB)
              </p>
            )}
            {uploadBusy && uploadProgress?.phase === "uploading" && uploadProgress.pct !== null && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={uploadProgress.pct} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress">
                <div className="h-full rounded-full bg-emerald-600 transition-[width]" style={{ width: `${uploadProgress.pct}%` }} />
              </div>
            )}
            {uploadBusy && uploadProgress?.phase === "processing" && (
              <p role="status" className="mt-2 text-[12px] text-muted-foreground">
                Upload complete — securing and registering your asset… This can take a minute for large files.
              </p>
            )}
            {uploadError && <p role="alert" className="mt-2 text-[12px] text-rose-600 dark:text-rose-300">{uploadError}</p>}
          </div>
          )}
          {tab === "url" && (
          <div className="mt-4" role="tabpanel" id={`${uid}-panel-url`} aria-labelledby={`${uid}-tab-url`} tabIndex={0}>
          <p className="mb-3 text-[12px] text-muted-foreground">Advanced path: reference a publicly hosted file. Only the URL and its fingerprint are recorded - the bytes stay with the creator.</p>
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
              disabled={busy || uploadBusy || !canSubmit}
              aria-busy={busy || uploadBusy}
              aria-describedby={submitHint}
              title={!canSubmit ? "Choose a creator and paste a public http(s) URL to enable registration" : undefined}
              className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
            >
              <Link2 className="h-4 w-4" aria-hidden /> {busy ? "Registering…" : "Register"}
            </Button>
          </div>
          <p id={submitHint} className={cn("mt-2 text-[11.5px]", busy && registerAction.status ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground")}>
            {!canSubmit
              ? "Register is disabled until a creator is chosen and a public URL is pasted - placeholders don't count."
              : busy && registerAction.status
                ? registerAction.status
                : "Only the URL and its reference fingerprint enter the evidence layer."}
          </p>
          </div>
          )}
          {/* Cancellation notice lives outside the tab panels: aborting an
              active upload by switching tabs must still show the honest
              notice on the URL tab. Inactive panels unmount, so screen
              readers never meet hidden tab content. */}
          {uploadNote && <p role="status" className="mt-2 text-[12px] text-muted-foreground">{uploadNote}</p>}
          <div className="mt-3 border-t border-border pt-3">
            <button
              type="button"
              onClick={() => { setCreatorOpen((v) => !v); setCreatorError(null); }}
              aria-expanded={creatorOpen}
              className="text-[12.5px] font-medium text-emerald-700 hover:underline dark:text-emerald-300"
            >
              {creatorOpen ? "Hide creator form" : (creators !== null && creators.length === 0) ? "Add the first creator" : "Add a new creator"}
            </button>
            {(creators !== null && creators.length === 0) && !creatorOpen && (
              <p className="mt-1 text-[12px] text-muted-foreground">
                A new workspace starts empty: add a creator, then register their media, then request consent.
              </p>
            )}
            {creatorOpen && (
              <div className="mt-2 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <div className="space-y-1.5">
                  <Label htmlFor={`${uid}-creator-name`} className="text-[12px] text-muted-foreground">Creator name (required)</Label>
                  <Input
                    id={`${uid}-creator-name`}
                    value={creatorName}
                    onChange={(e) => { setCreatorName(e.target.value); setCreatorError(null); }}
                    placeholder="Maya Chen"
                    className="rounded-xl placeholder:italic placeholder:text-muted-foreground/50"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${uid}-creator-handle`} className="text-[12px] text-muted-foreground">Handle (optional)</Label>
                  <Input
                    id={`${uid}-creator-handle`}
                    value={creatorHandle}
                    onChange={(e) => { setCreatorHandle(e.target.value); setCreatorError(null); }}
                    placeholder="@maya"
                    className="rounded-xl placeholder:italic placeholder:text-muted-foreground/50"
                  />
                </div>
                <Button
                  onClick={addCreator}
                  disabled={creatorBusy}
                  aria-busy={creatorBusy}
                  className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
                >
                  {creatorBusy ? "Adding…" : "Add creator"}
                </Button>
              </div>
            )}
            {creatorOpen && (
              <p className="mt-1.5 text-[11.5px] text-muted-foreground">
                A creator record is a workspace label for who appears - it does not verify identity or legal ownership. Only a consent link creates a permission.
              </p>
            )}
            {creatorError && <p role="alert" className="mt-2 text-[12px] text-rose-600 dark:text-rose-300">{creatorError}</p>}
          </div>
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
          Registered inputs for generation - URL references store only the reference and its fingerprint; uploads are private workspace copies.
        </p>
      <Stagger className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(media ?? []).map((m) => (
          <StaggerItem key={m.id}>
            <div className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card">
              {m.source === "upload" && m.type === "image" ? (
                <div className="relative aspect-video w-full bg-muted" title={`${m.title} (private workspace copy - workspace-only preview)`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/media/${m.id}/preview`} alt={m.title} className="aspect-video w-full object-cover" loading="lazy" />
                  <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-medium text-white">
                    <Lock className="h-3 w-3" aria-hidden /> Private upload
                  </span>
                </div>
              ) : m.source === "upload" ? (
                <div className="grid aspect-video w-full place-items-center bg-muted" title="Private workspace copy - video previews are not available">
                  <span className="flex items-center gap-1.5 rounded-full bg-card px-3 py-1 text-[11px] font-medium text-muted-foreground ring-1 ring-border">
                    <Lock className="h-3.5 w-3.5" aria-hidden /> Private upload · {m.type}
                  </span>
                </div>
              ) : m.type === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={m.url} alt={m.title} className="aspect-video w-full object-cover" loading="lazy" />
              ) : (
                <video src={m.url} className="aspect-video w-full bg-black object-contain" controls preload="metadata" />
              )}
              <div className="min-w-0 p-4">
                <p className="text-[13.5px] font-medium leading-snug">{m.title}</p>
                <CopyableIdentifier value={m.id} className="mt-1 max-w-full text-[10.5px]" />
                <p className="mt-0.5 break-all font-mono text-[10px] text-muted-foreground" title={m.source === "upload" ? `content fingerprint ${m.hash}` : `reference fingerprint ${m.hash}`}>
                  fingerprint {m.hash.slice(0, 24)}…
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
          body="Register the first approved asset above, then brief a campaign - the permission check runs automatically before anything is produced."
        />
      )}
      {media && media.length > 0 && (
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          Provenance note: records are keyed by stable IDs, so registering the same URL twice creates two
          separate records. PermitFrame never deletes or merges them - newest first is just display order.
        </p>
      )}
      <GeneratedOutputs campaigns={snapshot.data?.campaigns ?? null} />
    </div>
  );
}

/**
 * Generated campaign outputs, kept visually separate from approved source
 * media. Finished assets live with their campaigns - this section links
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
        Finished assets belong to their campaigns - open a pack to review, approve, and verify each output.
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
                c.generatedMediaType === "video" ? (
                  <span className="relative block aspect-video w-full bg-black">
                    <video
                      src={c.generatedUrl}
                      muted
                      playsInline
                      preload="metadata"
                      aria-label={`Generated video preview for ${c.title}`}
                      className="h-full w-full object-cover"
                    />
                    <span className="absolute bottom-2 right-2 rounded-full bg-black/70 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-white">
                      Video
                    </span>
                  </span>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.generatedUrl} alt={c.title} loading="lazy" className="aspect-video w-full object-cover" />
                )
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
