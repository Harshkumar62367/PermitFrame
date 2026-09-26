"use client";

import { useEffect, useRef } from "react";
import { apiGet } from "@/lib/api";
import { narrationDisplayStatus, type FilmNarrationJob } from "@/server/livepeer/narration-policy";

const BACKOFF_MS = [2000, 4000, 8000, 15000, 30000];

function signatureOf(jobs: FilmNarrationJob[]): string {
  return JSON.stringify(jobs.map((j) => `${j.id}:${narrationDisplayStatus(j)}:${j.narratedUrl ?? ""}`));
}

function isTerminal(status: string): boolean {
  return status === "ready" || status === "failed" || status === "cancelled" || status === "outcome_unknown";
}

/**
 * Follows a run's narration jobs with backoff polling while any is
 * active. The status route is strictly read-only (phases advance only
 * through the detached pump), so this only refreshes stored records -
 * it never dispatches provider work.
 */
export function useFilmNarrationProgress(
  campaignId: string,
  filmRunId: string,
  jobs: FilmNarrationJob[] | undefined,
  onChanged: () => Promise<void>
): void {
  const changedRef = useRef(onChanged);
  const jobsRef = useRef(jobs);
  const lastSig = useRef<string | null>(null);

  useEffect(() => {
    changedRef.current = onChanged;
  }, [onChanged]);

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const controller = new AbortController();
    lastSig.current = jobsRef.current ? signatureOf(jobsRef.current) : null;

    const activeIds = (): string[] =>
      (jobsRef.current ?? []).filter((j) => !isTerminal(narrationDisplayStatus(j))).map((j) => j.id);

    const poll = async (): Promise<void> => {
      if (cancelled) return;
      const ids = activeIds();
      if (ids.length === 0) return;
      try {
        for (const jobId of ids) {
          if (cancelled) return;
          const next = await apiGet<{ ok: boolean; narrationJob: FilmNarrationJob }>(
            `/api/campaigns/${campaignId}/film-runs/${filmRunId}/narrations/${jobId}`,
            controller.signal,
            15000
          );
          if (cancelled) return;
          const current = (jobsRef.current ?? []).map((j) =>
            j.id === jobId ? { ...next.narrationJob, script: j.script } : j
          );
          jobsRef.current = current;
          const sig = signatureOf(current);
          if (lastSig.current !== null && sig !== lastSig.current) {
            lastSig.current = sig;
            void changedRef.current().catch(() => undefined);
          } else {
            lastSig.current = sig;
          }
        }
      } catch {
        // Transient: back off and try again while work is active.
      }
      if (cancelled) return;
      if (activeIds().length === 0) return;
      attempt += 1;
      timer = setTimeout(() => void poll(), BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
    };

    if (activeIds().length > 0) void poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [campaignId, filmRunId]);
}
