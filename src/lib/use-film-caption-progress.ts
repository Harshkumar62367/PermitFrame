"use client";

import { useEffect, useRef } from "react";
import { apiGet } from "@/lib/api";
import type { FilmCaptionJob } from "@/server/livepeer/film-captions";

const BACKOFF_MS = [2000, 4000, 8000, 15000, 30000];

function signatureOf(jobs: FilmCaptionJob[]): string {
  return JSON.stringify(jobs.map((j) => `${j.id}:${j.status}:${j.captionedUrl ?? ""}`));
}

function isTerminal(status: string): boolean {
  return status === "ready" || status === "failed" || status === "cancelled";
}

/**
 * Follows a run's caption jobs with backoff polling while any is active.
 * The status route is strictly read-only (the transcribe call cannot be
 * polled), so this only refreshes stored records - it never dispatches
 * provider work. Separate from the film-progress hook: caption rows carry
 * their own signature and endpoints.
 */
export function useFilmCaptionProgress(
  campaignId: string,
  filmRunId: string,
  jobs: FilmCaptionJob[] | undefined,
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
      (jobsRef.current ?? []).filter((j) => !isTerminal(j.status)).map((j) => j.id);

    const poll = async (): Promise<void> => {
      if (cancelled) return;
      const ids = activeIds();
      if (ids.length === 0) return;
      try {
        for (const jobId of ids) {
          if (cancelled) return;
          const next = await apiGet<{ ok: boolean; captionJob: FilmCaptionJob }>(
            `/api/campaigns/${campaignId}/film-runs/${filmRunId}/captions/${jobId}`,
            controller.signal,
            15000
          );
          if (cancelled) return;
          const current = (jobsRef.current ?? []).map((j) => (j.id === jobId ? next.captionJob : j));
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
