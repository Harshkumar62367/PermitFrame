"use client";

import { Check, X } from "lucide-react";
import type { SnapshotPreflight } from "@/lib/use-workspace-snapshot";

/**
 * One-line rights-check verdict for cards: the live check result in plain
 * language. Driven entirely by API data - no hardcoded reasons.
 */
export function PolicyResultLine({ preflight, className }: { preflight: SnapshotPreflight; className?: string }) {
  if (preflight.decision === "pending") {
    return <p className={className}>Permission check has not run yet.</p>;
  }
  if (preflight.decision === "block") {
    const [first, ...rest] = preflight.blockers;
    return (
      <p className={className}>
        <span className="font-medium text-rose-700 dark:text-rose-300">
          Blocked: {first?.message ?? "policy conflict"}
        </span>
        {rest.length > 0 && <span className="text-muted-foreground"> (+{rest.length} more)</span>}
      </p>
    );
  }
  const claims = preflight.allowedClaims.length > 0 ? ` · “${preflight.allowedClaims[0]}” verified` : "";
  return (
    <p className={className}>
      <span className="font-medium text-emerald-700 dark:text-emerald-300">Approved against rights and facts{claims}</span>
    </p>
  );
}

/**
 * Full decision detail for the Needs-attention panel: every failed rule with
 * its evidence source, or the verified checks for an approval.
 */
export function PolicyDecisionSummary({ preflight }: { preflight: SnapshotPreflight }) {
  if (preflight.decision === "pending") {
    return <p className="text-[13px] text-muted-foreground">Run the permission check to see the decision.</p>;
  }
  if (preflight.decision === "block") {
    return (
      <ul className="space-y-2">
        {preflight.blockers.map((b, i) => (
          <li
            key={`${b.code}-${i}`}
            className="flex items-start gap-2.5 rounded-xl bg-rose-100/60 p-3 ring-1 ring-rose-200 dark:bg-rose-950/50 dark:ring-rose-900"
          >
            <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-rose-600 text-white" aria-hidden>
              <X className="h-3 w-3" />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-medium leading-snug text-rose-950 dark:text-rose-100">{b.message}</span>
              <span className="mt-0.5 block truncate font-mono text-[10px] uppercase tracking-[0.1em] text-rose-700 dark:text-rose-300/70" title={b.evidenceRefs.join(", ")}>
                {b.code} · evidence: {b.evidenceRefs.join(", ") || "no approved rights or brand rules matched"}
              </span>
            </span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="space-y-2">
      {preflight.allowedClaims.map((claim) => (
        <li key={claim} className="flex items-start gap-2 text-[13px] leading-snug text-emerald-950/85 dark:text-emerald-100/90">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
          <span>“{claim}” verified against product facts</span>
        </li>
      ))}
      {preflight.allowedClaims.length === 0 && (
        <li className="flex items-start gap-2 text-[13px] leading-snug text-emerald-950/85 dark:text-emerald-100/90">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
          <span>No claims requested - permission check passed</span>
        </li>
      )}
    </ul>
  );
}
