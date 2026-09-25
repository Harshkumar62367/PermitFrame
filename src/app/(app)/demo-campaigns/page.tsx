import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Eye, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FadeIn } from "@/components/motion-primitives";
import { PageHeader } from "@/components/ui/page-header";
import { DemoBriefButton } from "@/components/demo/demo-brief-button";
import {
  DEMO_BOUNDARY_NOTICE,
  DEMO_CAMPAIGNS,
  DEMO_NO_EVIDENCE_LABEL,
  DEMO_ONLY_LABEL,
  DEMO_READONLY_LABEL,
  type DemoCampaign,
  type DemoFormat
} from "@/lib/demo-campaigns";

export const metadata: Metadata = {
  title: "Demo campaigns",
  description: "Three read-only PermitFrame workflow walkthroughs for hackathon evaluation. No generation, evidence, or proof exists for these demos."
};

/**
 * Read-only demo gallery. Renders purely from local definitions - no
 * workspace reads, no snapshot, no provider or ledger calls, no mutations.
 * Auth is inherited from the (app) layout, which redirects unauthenticated
 * requests to the landing page. Demo cards never appear in the user's own
 * campaign list.
 */
function FormatTile({ format }: { format: DemoFormat }) {
  return (
    <div className="min-w-0">
      <div
        aria-hidden
        style={{ aspectRatio: format.ratio.replace(":", " / ") }}
        className="grid w-full place-items-center rounded-xl bg-muted font-mono text-[12px] text-muted-foreground ring-1 ring-border"
      >
        {format.ratio}
      </div>
      <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
        <span className="font-mono text-foreground">{format.ratio}</span> - {format.placement}
      </p>
    </div>
  );
}

function DemoCard({ demo }: { demo: DemoCampaign }) {
  return (
    <article
      aria-label={`${demo.title} (demo walkthrough)`}
      className="flex min-w-0 flex-col rounded-2xl border border-border bg-card p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950/50 dark:text-amber-200 dark:ring-amber-900">
          {DEMO_ONLY_LABEL}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground ring-1 ring-border">
          <Lock className="h-3 w-3" aria-hidden /> {DEMO_READONLY_LABEL}
        </span>
      </div>
      <h2 className="mt-3 text-[16px] font-semibold tracking-tight">{demo.title}</h2>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{demo.tagline}</p>

      <h3 className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
        Intended formats and placements
      </h3>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        {demo.formats.map((format) => (
          <FormatTile key={`${demo.id}-${format.ratio}`} format={format} />
        ))}
      </div>
      {demo.motionNote && (
        <p role="note" className="mt-3 rounded-xl bg-muted/60 px-3.5 py-2.5 text-[12px] leading-relaxed text-muted-foreground ring-1 ring-border">
          {demo.motionNote}
        </p>
      )}

      <h3 className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
        How this workflow runs
      </h3>
      <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-[12.5px] leading-relaxed text-muted-foreground marker:text-foreground">
        {demo.workflow.map((step, i) => (
          <li key={`${demo.id}-step-${i}`}>{step}</li>
        ))}
      </ol>

      <h3 className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
        Required user inputs
      </h3>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[12.5px] leading-relaxed text-muted-foreground marker:text-foreground">
        {demo.requiredInputs.map((input, i) => (
          <li key={`${demo.id}-input-${i}`}>{input}</li>
        ))}
      </ul>

      <h3 className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
        PermitFrame pre-spend checks
      </h3>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[12.5px] leading-relaxed text-muted-foreground marker:text-foreground">
        {demo.preSpendChecks.map((check, i) => (
          <li key={`${demo.id}-check-${i}`}>{check}</li>
        ))}
      </ul>

      <div className="mt-5 flex flex-1 flex-col justify-end border-t border-border pt-4">
        <p className="text-[11.5px] font-medium text-muted-foreground">{DEMO_NO_EVIDENCE_LABEL}</p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{DEMO_BOUNDARY_NOTICE}</p>
        <div className="mt-3">
          <DemoBriefButton demoId={demo.id} demoTitle={demo.title} />
        </div>
      </div>
    </article>
  );
}

export default function DemoCampaignsPage() {
  return (
    <div className="pf-page space-y-6">
      <FadeIn>
        <PageHeader
          eyebrow="Demo gallery"
          title="Demo campaigns"
          description="Three realistic PermitFrame workflows to inspect before briefing a real campaign. Everything here is descriptive - nothing generates, spends, or records proof."
          actions={
            <Button asChild variant="outline" className="rounded-full">
              <Link href="/campaigns">
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to your campaigns
              </Link>
            </Button>
          }
        />
      </FadeIn>
      <FadeIn delay={0.05}>
        <p
          role="note"
          className="flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-[12.5px] leading-relaxed text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900"
        >
          <Eye className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold">{DEMO_ONLY_LABEL} - {DEMO_READONLY_LABEL}.</span>{" "}
            {DEMO_NO_EVIDENCE_LABEL} Demo cards never mix with your campaign list and never create workspace data.
          </span>
        </p>
      </FadeIn>
      <FadeIn delay={0.08}>
        <aside className="rounded-xl border border-border bg-muted/35 px-4 py-3 text-[12.5px] leading-relaxed text-muted-foreground" aria-label="How demo workflows help">
          <span className="font-semibold text-foreground">How this helps:</span> use these examples to see the placement mix, the real inputs, and the checks required before spending. They are a planning reference for a first campaign, not a shortcut around creator permission, approved media, or brand rules.
        </aside>
      </FadeIn>
      <div className="grid items-start gap-4 xl:grid-cols-3 lg:grid-cols-2">
        {DEMO_CAMPAIGNS.map((demo, i) => (
          <FadeIn key={demo.id} delay={0.05 * (i + 1)}>
            <DemoCard demo={demo} />
          </FadeIn>
        ))}
      </div>
    </div>
  );
}
