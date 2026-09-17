"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { ArrowRight, SearchCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FadeIn } from "@/components/motion-primitives";
import { PageHeader } from "@/components/ui/page-header";
import { SectionCard } from "@/components/ui/section-card";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { campaignOutcome } from "@/components/campaign-outcome";
import { useWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";

export default function VerifierPage() {
  const router = useRouter();
  const uid = useId();
  const [ref, setRef] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Example shortcuts come from the shared ["workspace-snapshot"] cache —
  // never hardcoded, never a duplicate /api/campaigns read — so public
  // verification links remain stable as workspace data evolves. The public
  // /verify/[ref] routes stay separate and correctly public.
  const snapshot = useWorkspaceSnapshot();
  const examples = snapshot.data
    ? snapshot.data.campaigns.slice(0, 3)
    : snapshot.isError ? [] : null;

  function submit() {
    if (!ref.trim()) {
      setFieldError("Paste a verification reference (vrf_…) first.");
      return;
    }
    setFieldError(null);
    router.push(`/verify/${encodeURIComponent(ref.trim())}`);
  }

  const inputId = `${uid}-ref`;

  return (
    <div className="pf-page space-y-6">
      <FadeIn>
        <PageHeader
          eyebrow="Verification"
          title="Verification"
          description="Campaign history, client proof links, and evidence status — paste a receipt or campaign reference to open its public proof page, the same view your client sees."
          width="narrow"
        />
      </FadeIn>
      <FadeIn delay={0.02}>
        <div className="rounded-2xl border border-border bg-card p-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">What your client can verify</p>
          <ul className="mt-2.5 space-y-1.5 text-[13px] leading-relaxed text-muted-foreground">
            <li className="flex gap-2"><span aria-hidden className="text-emerald-600 dark:text-emerald-400">·</span> The finished asset itself — what was actually delivered.</li>
            <li className="flex gap-2"><span aria-hidden className="text-emerald-600 dark:text-emerald-400">·</span> Which advertising claims were verified before production.</li>
            <li className="flex gap-2"><span aria-hidden className="text-emerald-600 dark:text-emerald-400">·</span> Who approved the content, for which platforms and territories, and until when.</li>
          </ul>
          <p className="mt-2.5 text-[12px] text-muted-foreground">No technical background needed — the proof page reads like a certificate, with optional technical details underneath.</p>
        </div>
      </FadeIn>
      <FadeIn delay={0.05}>
        <SectionCard
          title="Look up a record"
          description="Verification references look like vrf_… — find them on any approved campaign pack."
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="flex max-w-xl flex-col gap-2 sm:flex-row"
          >
            <div className="relative min-w-0 flex-1">
              <Label htmlFor={inputId} className="sr-only">Verification reference</Label>
              <SearchCheck className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                id={inputId}
                value={ref}
                onChange={(e) => {
                  setRef(e.target.value);
                  setFieldError(null);
                }}
                placeholder="vrf_…"
                aria-invalid={Boolean(fieldError)}
                aria-describedby={fieldError ? `${inputId}-error` : `${inputId}-hint`}
                className="rounded-xl pl-9 font-mono text-[13px]"
              />
            </div>
            <Button
              type="submit"
              className="shrink-0 rounded-xl bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
            >
              Verify
            </Button>
          </form>
          {fieldError ? (
            <p id={`${inputId}-error`} role="alert" className="mt-2 text-[12px] text-rose-600 dark:text-rose-300">{fieldError}</p>
          ) : (
            <p id={`${inputId}-hint`} className="mt-2 text-[11.5px] text-muted-foreground">
              Unknown references show a “not found” page — nothing is fabricated.
            </p>
          )}
        </SectionCard>
      </FadeIn>
      <FadeIn delay={0.1}>
        <SectionCard title="Try a real record from this workspace">
          {examples === null && <LoadingSkeleton rows={1} />}
          {examples !== null && examples.length === 0 && (
            <EmptyState
              title="No proof records yet"
              body="Brief a campaign to get a campaign reference, then produce its pack to create receipts. Each receipt links back to its source creative, approved rights, and claim evidence."
            />
          )}
          {examples !== null && examples.length > 0 && (
            <ul className="space-y-2">
              {examples.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => router.push(c.verificationRef ? `/verify/${c.verificationRef}` : `/campaigns/${c.id}`)}
                    className="group flex w-full min-w-0 items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-left transition hover:border-emerald-600/30"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium">{c.title}</span>
                      <span className="block truncate font-mono text-[10.5px] text-muted-foreground" title={c.id}>
                        {c.id} · {campaignOutcome({ status: c.effectiveStatus, decision: c.preflight.decision, hasOutputs: c.receiptsCount > 0, publicationStatus: c.recordPublicationStatus, campaignUAL: c.campaignUAL }).label}
                      </span>
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-emerald-700 dark:text-emerald-300">
                      {c.verificationRef ? "Verify" : "Open"} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </FadeIn>
      <FadeIn delay={0.15}>
        <p className="text-[12.5px] text-muted-foreground">
          Technical deep-dive?{" "}
          <Link href="/graph" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">
            Open the proof inspector
          </Link>{" "}
          for the underlying records and query console.
        </p>
      </FadeIn>
    </div>
  );
}
