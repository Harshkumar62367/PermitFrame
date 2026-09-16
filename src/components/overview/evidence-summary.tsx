"use client";

import { Database } from "lucide-react";

/**
 * Provenance line: which Knowledge Assets the verdict was checked against.
 * OriginTrail's responsibility made visible — rights + facts references, not labels.
 */
export function EvidenceSummary({
  knowledgeAssetsConsulted,
  queriedRights,
  queriedFacts,
  checkedAt,
  spentLabel
}: {
  knowledgeAssetsConsulted: number;
  queriedRights: string[];
  queriedFacts: string[];
  checkedAt: string | null;
  spentLabel: string;
}) {
  const refs = [...queriedRights, ...queriedFacts].filter(Boolean);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <Database className="h-3.5 w-3.5" aria-hidden />
        <span>
          {knowledgeAssetsConsulted > 0 ? (
            <>checked against {knowledgeAssetsConsulted} Knowledge Asset{knowledgeAssetsConsulted === 1 ? "" : "s"}</>
          ) : (
            <>no Knowledge Assets consulted yet</>
          )}
        </span>
      </span>
      <span aria-hidden className="text-border">·</span>
      <span>{spentLabel}</span>
      {checkedAt && (
        <>
          <span aria-hidden className="text-border">·</span>
          <time dateTime={checkedAt} title={new Date(checkedAt).toLocaleString()}>
            checked {new Date(checkedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </time>
        </>
      )}
      {refs.length > 0 && (
        <span className="inline-flex min-w-0 items-center gap-1">
          <span aria-hidden className="text-border">·</span>
          <span className="truncate font-mono text-[10.5px]" title={refs.join(" · ")}>
            {refs[0]}
            {refs.length > 1 && ` +${refs.length - 1}`}
          </span>
        </span>
      )}
    </div>
  );
}
