"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Check, FileSearch, Loader2, Sparkles } from "lucide-react";
import { CampaignThumbnail } from "./campaign-thumbnail";
import { EvidenceSummary } from "./evidence-summary";
import { StatusBadge } from "@/components/ui/status-badge";
import { apiPost } from "@/lib/api";
import { useInvalidateWorkspaceSnapshot, type SnapshotCampaign } from "@/lib/use-workspace-snapshot";

/**
 * The positive workflow: a cleared campaign with its verified checks and the
 * next production action. Generates through the real produce endpoint —
 * when outputs already exist it shows the generated media instead.
 */
export function ReadyToProducePanel({ campaign }: { campaign: SnapshotCampaign }) {
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasOutputs = campaign.receiptsCount > 0 && campaign.generatedUrl;
  const producing = campaign.activeJobs > 0 || busy;
  const rights = campaign.rights;
  const platformPermitted = rights?.platforms.some((p) => p.toLowerCase() === campaign.platform.toLowerCase()) ?? false;
  const territoryCovered = rights?.countries.some((c) => c.toLowerCase() === campaign.country.toLowerCase()) ?? false;

  async function generate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/campaigns/${campaign.id}/produce`);
      invalidateSnapshot();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Production failed to start.");
    } finally {
      setBusy(false);
    }
  }

  const checks: { ok: boolean; text: string }[] = [
    {
      ok: platformPermitted,
      text: platformPermitted
        ? `${campaign.platform} permitted by ${rights?.passportId}`
        : `${campaign.platform} — permission unclear, review rights`
    },
    {
      ok: territoryCovered,
      text: territoryCovered
        ? `${campaign.country} covered${rights?.validUntil ? ` until ${rights.validUntil}` : ""}`
        : `${campaign.country} — territory unclear, review rights`
    },
    ...campaign.preflight.allowedClaims.map((claim) => ({
      ok: true,
      text: `“${claim}” verified`
    })),
    {
      ok: (rights?.transformations.length ?? 0) > 0,
      text: `Transformations permitted${rights && rights.transformations.length > 0 ? `: ${rights.transformations.join(", ")}` : ""}`
    }
  ];

  return (
    <section
      aria-labelledby={`ready-${campaign.id}`}
      className="flex h-full flex-col overflow-hidden rounded-2xl border border-emerald-200 bg-card dark:border-emerald-900"
    >
      <div className="border-b border-emerald-200/70 bg-emerald-50/70 px-5 py-3 dark:border-emerald-900 dark:bg-emerald-950/30">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-300">
          {hasOutputs ? "Generated and receipted" : producing ? "Producing on Livepeer" : "Verified and ready"}
        </p>
      </div>

      <CampaignThumbnail
        src={hasOutputs && campaign.generatedUrl ? campaign.generatedUrl : campaign.thumbnailUrl}
        title={campaign.title}
        brand={campaign.brand}
      />

      <div className="flex flex-1 flex-col p-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={producing ? "generating" : campaign.effectiveStatus === "approved" ? "approved" : "ready"} />
          <span className="truncate font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
            {campaign.platform} · {campaign.country}
          </span>
        </div>
        <h3 id={`ready-${campaign.id}`} className="mt-2.5 text-[17px] font-semibold leading-snug tracking-tight">
          {campaign.title}
        </h3>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">
          {campaign.brand} · {campaign.creatorName}
        </p>

        <ul className="mt-4 space-y-2">
          {checks.map((check, i) => (
            <li key={i} className="flex items-start gap-2 text-[13px] leading-snug text-foreground/85 dark:text-white/85">
              <Check
                className={check.ok ? "mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" : "mt-0.5 h-4 w-4 shrink-0 text-amber-500"}
                aria-hidden
              />
              <span>{check.text}</span>
            </li>
          ))}
        </ul>

        <div className="mt-4">
          <EvidenceSummary
            knowledgeAssetsConsulted={campaign.preflight.knowledgeAssetsConsulted}
            queriedRights={campaign.preflight.queriedRights}
            queriedFacts={campaign.preflight.queriedFacts}
            checkedAt={campaign.preflight.checkedAt}
            spentLabel={campaign.spentUsd > 0 ? `$${campaign.spentUsd.toFixed(4)} inference spent` : "$0 spent so far"}
          />
        </div>

        {error && (
          <p role="alert" className="mt-3 break-words text-[12.5px] text-rose-600 dark:text-rose-300">
            {error}
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2 pt-1">
          {hasOutputs ? (
            <Link
              href={`/campaigns/${campaign.id}`}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-emerald-700 px-4 text-[13px] font-medium text-emerald-50 transition hover:bg-emerald-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
            >
              Open campaign pack <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => void generate()}
              disabled={producing}
              aria-busy={producing}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-emerald-700 px-4 text-[13px] font-medium text-emerald-50 transition hover:bg-emerald-600 disabled:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
            >
              {producing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Producing…
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" aria-hidden /> Generate with Livepeer
                </>
              )}
            </button>
          )}
          <Link
            href={`/campaigns/${campaign.id}#evidence`}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border px-4 text-[13px] font-medium text-foreground transition hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
          >
            <FileSearch className="h-3.5 w-3.5" aria-hidden /> View evidence
          </Link>
        </div>
      </div>
    </section>
  );
}
