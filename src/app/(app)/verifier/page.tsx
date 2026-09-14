"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { ArrowRight, SearchCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FadeIn } from "@/components/motion-primitives";
import { PageHeader } from "@/components/ui/page-header";
import { SectionCard } from "@/components/ui/section-card";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { apiGet } from "@/lib/api";

interface ExampleCampaign {
  id: string;
  title: string;
  status: string;
}

export default function VerifierPage() {
  const router = useRouter();
  const uid = useId();
  const [ref, setRef] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [examples, setExamples] = useState<ExampleCampaign[] | null>(null);

  // Example shortcuts come from live workspace data — never hardcoded —
  // so they keep working after demo seeds are removed.
  useEffect(() => {
    const controller = new AbortController();
    apiGet<{ campaigns: ExampleCampaign[] }>("/api/campaigns", controller.signal).then(
      (d) => setExamples((d.campaigns ?? []).slice(0, 3)),
      () => setExamples([])
    );
    return () => controller.abort();
  }, []);

  function submit() {
    if (!ref.trim()) {
      setFieldError("Paste a receipt ID, campaign ID, or UAL first.");
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
          eyebrow="Trust & proof"
          title="Verifier"
          description="Resolve any receipt ID, campaign ID, or UAL to its public verification page — the same view your clients see."
          width="narrow"
        />
      </FadeIn>
      <FadeIn delay={0.05}>
        <SectionCard
          title="Look up a record"
          description="Receipt IDs start with rcpt_, campaign IDs look like campaign_…, and DKG identifiers start with did:dkg:. Receipt IDs are created when a campaign pack is produced."
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="flex max-w-xl flex-col gap-2 sm:flex-row"
          >
            <div className="relative min-w-0 flex-1">
              <Label htmlFor={inputId} className="sr-only">Receipt, campaign, or UAL reference</Label>
              <SearchCheck className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                id={inputId}
                value={ref}
                onChange={(e) => {
                  setRef(e.target.value);
                  setFieldError(null);
                }}
                placeholder="rcpt_… · campaign_… · did:dkg:…"
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
              title="No verifiable records yet"
              body="Create a campaign to get a campaign ID, then produce its pack to mint receipt IDs. Each receipt links back to its source media, permission passport, and claim evidence."
            />
          )}
          {examples !== null && examples.length > 0 && (
            <ul className="space-y-2">
              {examples.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => router.push(`/verify/${encodeURIComponent(c.id)}`)}
                    className="group flex w-full min-w-0 items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-left transition hover:border-emerald-600/30"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium">{c.title}</span>
                      <span className="block truncate font-mono text-[10.5px] text-muted-foreground" title={c.id}>
                        {c.id} · {c.status}
                      </span>
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-emerald-700 dark:text-emerald-300">
                      Verify <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </FadeIn>
    </div>
  );
}
