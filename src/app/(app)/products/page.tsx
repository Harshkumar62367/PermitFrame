"use client";

import { useId, useState } from "react";
import { Plus, ShieldCheck, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FadeIn, Stagger, StaggerItem } from "@/components/motion-primitives";
import { PageHeader } from "@/components/ui/page-header";
import { RightsTabs } from "@/components/rights-tabs";
import { SectionCard } from "@/components/ui/section-card";
import { CopyableIdentifier } from "@/components/ui/identifier";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { apiPost, describeRecord } from "@/lib/api";
import { useLongAction } from "@/lib/use-long-action";
import { useInvalidateDkgGraph } from "@/lib/use-dkg-graph";
import { useInvalidateWorkspaceSnapshot, useWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import { cn } from "@/lib/utils";
import type { ProductFacts } from "@/server/types";

const EMPTY_FORM = { brand: "", productName: "", approved: "", prohibited: "", guidelines: "", evidence: "" };

const EXAMPLE_FORM = {
  brand: "Verdi Steps",
  productName: "TerraRunner",
  approved: "made with recycled materials, carbon-neutral shipping",
  prohibited: "waterproof",
  guidelines: "Earthy, natural palette.\nNo aggressive superlatives.",
  evidence: "Product spec sheet v3.2; certification FR-0921"
};

export default function ProductsPage() {
  const uid = useId();
  // Product facts read from the shared ["workspace-snapshot"] cache: cached
  // rows render instantly and stay visible during background refetches. An
  // inline skeleton shows only when no cached snapshot exists at all.
  const snapshot = useWorkspaceSnapshot();
  const factsList = snapshot.data?.productFacts ?? null;
  const loadError = !snapshot.data && snapshot.isError
    ? (snapshot.error instanceof Error ? snapshot.error.message : "Brand rules failed to load.")
    : null;
  const [editing, setEditing] = useState<ProductFacts | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<{ brand?: string; productName?: string; overlap?: string }>({});
  const saveAction = useLongAction({
    working: "Saving brand rules…",
    slow: "Still saving and recording the brand rules. Please keep this page open - proof services can take a little longer.",
    timedOut:
      "Saving is taking longer than expected. Refresh this page once before retrying - the brand rules may already have been saved."
  });
  const busy = saveAction.busy;
  const [result, setResult] = useState<{ ok: boolean; text: string; ual?: string } | null>(null);
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();
  const invalidateDkgGraph = useInvalidateDkgGraph();

  function startEdit(f: ProductFacts) {
    setEditing(f);
    setResult(null);
    setFieldErrors({});
    setForm({
      brand: f.brand,
      productName: f.productName,
      approved: f.approvedClaims.join(", "),
      prohibited: f.prohibitedClaims.join(", "),
      guidelines: f.guidelines.join("\n"),
      evidence: f.evidenceNotes
    });
  }

  function cancelEdit() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFieldErrors({});
  }

  function fillExample() {
    setForm(EXAMPLE_FORM);
    setFieldErrors({});
    setResult(null);
  }

  async function save() {
    if (saveAction.busy) return;
    const errors: typeof fieldErrors = {};
    if (!form.brand.trim()) errors.brand = "Brand is required.";
    if (!form.productName.trim()) errors.productName = "Product name is required.";
    const approved = form.approved.split(",").map((c) => c.trim()).filter(Boolean);
    const prohibited = form.prohibited.split(",").map((c) => c.trim()).filter(Boolean);
    const overlap = approved.filter((c) => prohibited.some((p) => p.toLowerCase() === c.toLowerCase()));
    if (overlap.length > 0) errors.overlap = `A claim cannot be both approved and prohibited: ${overlap.join(", ")}.`;
    setFieldErrors(errors);
    setResult(null);
    if (errors.brand || errors.productName || errors.overlap) return;

    // Saving publishes a Knowledge Asset, so it can legitimately outlast
    // the default 30s browser budget - 120s with slow status and
    // refresh-first recovery. Input is preserved for retry either way.
    const result = await saveAction.execute(() =>
      apiPost<{ facts: ProductFacts }>("/api/facts", {
        id: editing?.id,
        brand: form.brand,
        productName: form.productName,
        approvedClaims: approved,
        prohibitedClaims: prohibited,
        guidelines: form.guidelines.split("\n").map((g) => g.trim()).filter(Boolean),
        evidenceNotes: form.evidence
      }, undefined, saveAction.timeoutMs)
    );
    if (!result.ok || !result.value) {
      if (result.message) setResult({ ok: false, text: result.message });
      return;
    }
    const j = result.value;
      const record = describeRecord(j.facts.ual);
      setResult({
        ok: true,
        text: editing
          ? `${record.headline} - ${j.facts.brand} ${j.facts.productName} updated. ${record.detail}`
          : `${record.headline} - ${j.facts.brand} ${j.facts.productName} is now enforced by the permission check. ${record.detail}`,
        ual: j.facts.ual
      });
      cancelEdit();
      // Publishing facts writes a Knowledge Asset: refresh the shared
      // snapshot (awaited, so the new row appears) and mark cached graph stale.
      await invalidateSnapshot();
      invalidateDkgGraph();
  }

  const canSubmit = form.brand.trim().length > 0 && form.productName.trim().length > 0;
  const submitHint = `${uid}-submit-hint`;

  return (
    <div className="pf-page space-y-6">
      <FadeIn>
        <PageHeader
          eyebrow="Brand rules"
          title="Brand rules"
          description="Set the product claims, required disclosures, and restrictions that every campaign must follow. These rules are checked during campaign preflight before any Livepeer generation begins."
        />
      </FadeIn>
      <FadeIn delay={0.02}>
        <RightsTabs />
      </FadeIn>

      <FadeIn delay={0.05}>
        <SectionCard
          title={editing ? `Editing ${editing.brand} ${editing.productName}` : "Add brand rules"}
          description="Guided scenario - every field starts empty; grey placeholder text is only an example, never a value. Use suggested values to accelerate data entry."
          actions={
            !editing && (
              <Button variant="outline" size="sm" onClick={fillExample} className="h-7 rounded-full px-2.5 text-[11.5px]">
                <Wand2 className="h-3 w-3" aria-hidden /> Fill guided example
              </Button>
            )
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-brand`} className="text-[12px] text-muted-foreground">Brand</Label>
              <Input
                id={`${uid}-brand`}
                value={form.brand}
                aria-invalid={Boolean(fieldErrors.brand)}
                aria-describedby={fieldErrors.brand ? `${uid}-brand-error` : undefined}
                onChange={(e) => {
                  setForm((f) => ({ ...f, brand: e.target.value }));
                  setFieldErrors((p) => ({ ...p, brand: undefined }));
                }}
                placeholder="Verdi Steps"
                className={cn("rounded-xl placeholder:italic placeholder:text-muted-foreground/50", fieldErrors.brand && "border-rose-500")}
              />
              {fieldErrors.brand && <p id={`${uid}-brand-error`} role="alert" className="text-[12px] text-rose-600 dark:text-rose-300">{fieldErrors.brand}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-product`} className="text-[12px] text-muted-foreground">Product</Label>
              <Input
                id={`${uid}-product`}
                value={form.productName}
                aria-invalid={Boolean(fieldErrors.productName)}
                aria-describedby={fieldErrors.productName ? `${uid}-product-error` : undefined}
                onChange={(e) => {
                  setForm((f) => ({ ...f, productName: e.target.value }));
                  setFieldErrors((p) => ({ ...p, productName: undefined }));
                }}
                placeholder="TerraRunner"
                className={cn("rounded-xl placeholder:italic placeholder:text-muted-foreground/50", fieldErrors.productName && "border-rose-500")}
              />
              {fieldErrors.productName && <p id={`${uid}-product-error`} role="alert" className="text-[12px] text-rose-600 dark:text-rose-300">{fieldErrors.productName}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-approved`} className="text-[12px] text-muted-foreground">Approved claims (comma-separated)</Label>
              <Input
                id={`${uid}-approved`}
                value={form.approved}
                onChange={(e) => setForm((f) => ({ ...f, approved: e.target.value }))}
                placeholder="made with recycled materials"
                className="rounded-xl placeholder:italic placeholder:text-muted-foreground/50"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-prohibited`} className="text-[12px] text-muted-foreground">Prohibited claims (comma-separated)</Label>
              <Input
                id={`${uid}-prohibited`}
                value={form.prohibited}
                onChange={(e) => setForm((f) => ({ ...f, prohibited: e.target.value }))}
                placeholder="waterproof"
                className="rounded-xl placeholder:italic placeholder:text-muted-foreground/50"
              />
            </div>
            {fieldErrors.overlap && (
              <p role="alert" className="text-[12px] text-rose-600 sm:col-span-2 dark:text-rose-300">{fieldErrors.overlap}</p>
            )}
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${uid}-guidelines`} className="text-[12px] text-muted-foreground">Brand guidelines (one per line)</Label>
              <Textarea
                id={`${uid}-guidelines`}
                value={form.guidelines}
                onChange={(e) => setForm((f) => ({ ...f, guidelines: e.target.value }))}
                rows={3}
                placeholder={"Earthy, natural palette.\nNo aggressive superlatives."}
                className="rounded-xl placeholder:italic placeholder:text-muted-foreground/50"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${uid}-evidence`} className="text-[12px] text-muted-foreground">Evidence notes (where the facts come from)</Label>
              <Input
                id={`${uid}-evidence`}
                value={form.evidence}
                onChange={(e) => setForm((f) => ({ ...f, evidence: e.target.value }))}
                placeholder="Product spec sheet v3.2; certification FR-0921"
                className="rounded-xl placeholder:italic placeholder:text-muted-foreground/50"
              />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              onClick={save}
              disabled={busy || !canSubmit}
              aria-busy={busy}
              aria-describedby={submitHint}
              title={!canSubmit ? "Enter a brand and product name to enable publishing" : undefined}
              className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
            >
              <ShieldCheck className="h-4 w-4" aria-hidden /> {busy ? "Saving…" : editing ? "Save changes" : "Save brand rules"}
            </Button>
            {editing && (
              <Button variant="ghost" onClick={cancelEdit} disabled={busy} className="rounded-full">
                Cancel
              </Button>
            )}
          </div>
          <p id={submitHint} className="mt-2 text-[11.5px] text-muted-foreground">
            {!canSubmit
              ? "Save is disabled until brand and product name are filled - placeholders don't count."
              : busy && saveAction.status
                ? saveAction.status
                : "Saves to the workspace and its proof record; the permission check enforces it immediately."}
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
      {!factsList && !loadError && <LoadingSkeleton rows={2} />}
      <Stagger className="grid gap-4 md:grid-cols-2">
        {(factsList ?? []).map((f) => (
          <StaggerItem key={f.id}>
            <div className="h-full min-w-0 rounded-2xl border border-border bg-card p-5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[14.5px] font-semibold">{f.brand} {f.productName}</p>
                  <CopyableIdentifier value={f.id} className="mt-0.5 max-w-full text-[10px]" />
                </div>
                <Button variant="ghost" size="sm" onClick={() => startEdit(f)} className="h-7 shrink-0 rounded-full px-2.5 text-[11.5px]">
                  <Plus className="h-3 w-3" aria-hidden /> Edit
                </Button>
              </div>
              <div className="mt-3 space-y-2 text-[12.5px]">
                <p><span className="text-emerald-700 dark:text-emerald-300">approved:</span> {f.approvedClaims.join(", ") || "-"}</p>
                <p><span className="text-rose-600 dark:text-rose-300">prohibited:</span> {f.prohibitedClaims.join(", ") || "-"}</p>
                {f.guidelines.length > 0 && <p className="text-muted-foreground">guidelines: {f.guidelines.join(" · ")}</p>}
              </div>
            </div>
          </StaggerItem>
        ))}
      </Stagger>
      {factsList && factsList.length === 0 && !loadError && (
        <EmptyState
          title="No brand rules yet"
          body="Add the first brand above - campaigns can't claim anything until its rules exist. Next: add creator rights and creative, then brief a campaign."
        />
      )}
    </div>
  );
}
