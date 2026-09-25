"use client";

import { useEffect, useState } from "react";
import { Check, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import { useLongAction } from "@/lib/use-long-action";
import { useInvalidateWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import { cn } from "@/lib/utils";
import type { Campaign, PermissionPassport, ProductFacts, SourceMedia } from "@/server/types";
import { StudioHeader } from "./studio-header";
import { BriefPanel } from "./brief-panel";
import { TemplatePanel } from "./template-panel";
import { useFilmPlan } from "./use-film-plan";
import { CreativePlan } from "./creative-plan";
import { QueuePanel } from "./queue-panel";
import { ReviewSection } from "./review-section";
import { PackSection } from "./pack-section";
import { SimulationPanel } from "./simulation-panel";

interface CreativeStudioProps {
  campaign: Campaign;
  sourceMedia: SourceMedia | null;
  passport: PermissionPassport | null;
  productFacts: ProductFacts | null;
  onChanged: () => Promise<void>;
}

/**
 * Creative Studio: the working surface for rights-approved campaigns.
 * Generation stays locked unless the live preflight decision is allow -
 * the server enforces the same gate, so a stale client can never spend.
 * Blocked campaigns never reach this component; the workspace page renders
 * the blocked verdict (reasons + exact fix) instead.
 */
export function CreativeStudio({ campaign, sourceMedia, passport, productFacts, onChanged }: CreativeStudioProps) {
  const [recheckError, setRecheckError] = useState<string | null>(null);
  // Same 120s permission-evaluation policy as the campaign page re-check:
  // slow status after 5s, refresh-first recovery on timeout, manual retry only.
  const recheck = useLongAction({
    working: "Checking permissions…",
    slow: "Still checking approved rights and brand rules. Please keep this page open.",
    timedOut:
      "The permission check is taking longer than expected. Refresh once before retrying - the result may already be available."
  });
  const rechecking = recheck.busy;
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();

  const decision = campaign.preflight;
  const allowed = decision?.decision === "allow";
  // Film planning state lives here so the plan panel and the asset-plan
  // panel agree: while Film mode is selected, the asset Generate control
  // below carries a note that it still generates the current asset pack.
  const film = useFilmPlan({ campaign, allowed, onChanged });

  async function recheckNow() {
    if (recheck.busy) return;
    setRecheckError(null);
    const result = await recheck.execute(() =>
      // Re-checks consult the live ledger (rights + facts reads) and can
      // take well over the default 30s budget - allow two minutes.
      apiPost(`/api/campaigns/${campaign.id}/repreflight`, {}, undefined, recheck.timeoutMs)
    );
    if (!result.ok) {
      if (result.message) setRecheckError(result.message);
      return;
    }
    invalidateSnapshot();
    await onChanged();
  }

  return (
    <div className="min-w-0 space-y-4">
      <StudioHeader
        campaign={campaign}
        sourceMedia={sourceMedia}
        passport={passport}
        busy={rechecking}
        onRecheck={() => void recheckNow()}
      />
      <ServiceNotice />
      {recheck.busy && recheck.status && (
        <p role="status" className="break-words text-[12.5px] text-muted-foreground">{recheck.status}</p>
      )}
      {recheckError && (
        <p role="alert" className="break-words text-[12.5px] text-rose-600 dark:text-rose-300">{recheckError}</p>
      )}

      <TemplatePanel campaign={campaign} allowed={allowed} film={film} onChanged={onChanged} />

      {allowed ? (
        <>
          <details className="rounded-2xl border border-border bg-card px-5 py-3.5">
            <summary className="cursor-pointer text-[13px] font-semibold tracking-tight">
              Brief & controls
              <span className="ml-2 font-normal text-muted-foreground">Approved - edit only if the brief changes</span>
            </summary>
            <div className="pt-3">
              <BriefPanel campaign={campaign} passport={passport} productFacts={productFacts} onChanged={onChanged} />
            </div>
          </details>
          <div className="grid min-w-0 items-stretch gap-4 min-[1450px]:h-[min(720px,calc(100vh-2rem))] min-[1450px]:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.9fr)] min-[1600px]:grid-cols-[minmax(0,1.35fr)_minmax(380px,0.95fr)]">
            <CreativePlan campaign={campaign} allowed={allowed} filmMode={film.mode} onChanged={onChanged} />
            <QueuePanel campaign={campaign} allowed={allowed} onChanged={onChanged} />
          </div>
        </>
      ) : (
        <div className="grid items-start gap-4 xl:grid-cols-[300px_minmax(0,1fr)_320px] min-[1600px]:grid-cols-[320px_minmax(0,1fr)_360px]">
          <BriefPanel campaign={campaign} passport={passport} productFacts={productFacts} onChanged={onChanged} />
          <CreativePlan campaign={campaign} allowed={allowed} filmMode={film.mode} onChanged={onChanged} />
          <QueuePanel campaign={campaign} allowed={allowed} onChanged={onChanged} />
        </div>
      )}

      <section id="evidence" aria-label="Permission check record" className="scroll-mt-24 rounded-2xl border border-border bg-card p-5 sm:p-6">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-300">
          Why this was approved
        </p>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl bg-emerald-100/50 p-4 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:ring-emerald-900">
            <ul className="space-y-2 text-[13px] leading-relaxed text-emerald-950/85 dark:text-emerald-100/90">
              {decision?.queriedRights.length ? (
                <li className="flex min-w-0 gap-2">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden />
                  <span className="min-w-0 break-words">
                    Rights {decision.queriedRights[0]} - {passport?.platforms.join(", ")} · {passport?.countries.join(", ")}
                    {passport?.validUntil ? ` · valid to ${passport.validUntil}` : ""} · {passport?.allowedTransformations.join(", ")}
                  </span>
                </li>
              ) : null}
              {(decision?.allowedClaims.length ?? 0) > 0 && (
                <li className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden />
                  <span>Verified claims: {decision?.allowedClaims.join("; ")}</span>
                </li>
              )}
              {(decision?.queriedFacts.length ?? 0) > 0 && (
                <li className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden />
                  <span>Brand rules {decision?.queriedFacts[0]}</span>
                </li>
              )}
              <li className="flex items-center gap-2 text-[12px] text-emerald-800/70 dark:text-emerald-300/70">
                <RefreshCw className={cn("h-3.5 w-3.5", rechecking && "animate-spin")} aria-hidden />
                Checked {decision?.checkedAt ? new Date(decision.checkedAt).toLocaleString() : "-"}
              </li>
            </ul>
          </div>
          <div className="rounded-xl bg-card p-4 ring-1 ring-border">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Constraints compiled into every generation</p>
            <ul className="mt-2.5 list-disc space-y-1.5 pl-4 text-[12.5px] leading-relaxed text-muted-foreground">
              {(decision?.promptConstraints ?? []).map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          </div>
        </div>
        <div className="mt-4">
          <SimulationPanel campaignId={campaign.id} sparqlPreview={decision?.sparqlPreview ?? ""} />
        </div>
      </section>

      <ReviewSection campaign={campaign} onChanged={onChanged} />
      <PackSection campaign={campaign} onChanged={onChanged} />
    </div>
  );
}

interface ServiceHealth {
  dkg: { healthy: boolean; state?: "checking" | "healthy" | "degraded" | "unavailable" };
  livepeer: { reachable?: boolean; state?: "checking" | "healthy" | "degraded" | "unavailable" };
}

/**
 * Explicit external-dependency states, checked once and low-priority:
 * an unreachable production service or ledger is stated up front instead
 * of surfacing only as a failed job. Silent while unknown - job errors
 * remain the backstop.
 */
function ServiceNotice() {
  const [health, setHealth] = useState<ServiceHealth | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiGet<ServiceHealth>("/api/health", controller.signal).then(setHealth, () => undefined);
    return () => controller.abort();
  }, []);

  if (!health) return null;
  // Banner only on settled failures: a "checking" payload (no probe has
  // answered yet) stays silent - job errors remain the backstop.
  const down = (state: ServiceHealth["dkg"]["state"], flag: boolean) =>
    state ? state === "degraded" || state === "unavailable" : flag;
  const productionDown = down(health.livepeer.state, health.livepeer.reachable === false);
  const ledgerDown = down(health.dkg.state, !health.dkg.healthy);
  if (!productionDown && !ledgerDown) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-start gap-2.5 rounded-xl bg-amber-50 px-4 py-3 text-[12.5px] text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>
        {productionDown && "Production service unreachable - generation attempts will fail until it recovers. "}
        {ledgerDown && "Proof ledger offline - approvals and publishing pause; briefs, drafts and retries keep working."}
      </span>
    </div>
  );
}
