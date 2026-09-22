"use client";

import { useEffect, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import type { FilmRun } from "@/server/livepeer/film-run";

export interface FilmRunStatusResponse {
  ok: boolean;
  filmRun: FilmRun | null;
  label: string;
  reelReady: boolean;
}

const BACKOFF_MS = [2000, 4000, 8000, 15000, 30000];

function signatureOf(d: FilmRunStatusResponse): string {
  const run = d.filmRun;
  return JSON.stringify([
    run?.status,
    run?.reelUrl ?? "",
    (run?.sceneOutputs ?? []).map((s) => `${s.index}:${s.url}`).join(",")
  ]);
}

function isTerminal(run: FilmRun | null): boolean {
  return run?.status === "ready" || run?.status === "failed" || run?.status === "cancelled";
}

/**
 * Follows one film run with backoff polling (2s → 30s) while it is
 * active. Stops on terminal runs and cleans up on unmount or run change.
 * Separate from the short-asset run hook on purpose: film polls carry the
 * reel/scene-output signature, never stage/job rows.
 */
export function useFilmRunProgress(
  campaignId: string,
  filmRunId: string | null,
  onChanged: () => Promise<void>
): FilmRunStatusResponse | null {
  const [data, setData] = useState<FilmRunStatusResponse | null>(null);
  const lastSig = useRef<string | null>(null);
  const changedRef = useRef(onChanged);

  useEffect(() => {
    changedRef.current = onChanged;
  }, [onChanged]);

  useEffect(() => {
    if (!filmRunId) return;
    lastSig.current = null;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const controller = new AbortController();

    const poll = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const next = await apiGet<FilmRunStatusResponse>(
          `/api/campaigns/${campaignId}/film-runs/${filmRunId}`,
          controller.signal,
          15000
        );
        if (cancelled) return;
        setData(next);
        const sig = signatureOf(next);
        if (lastSig.current !== null && sig !== lastSig.current) {
          void changedRef.current().catch(() => undefined);
        }
        lastSig.current = sig;
        if (isTerminal(next.filmRun)) return;
      } catch {
        // Transient: back off and try again while still active.
      }
      if (cancelled) return;
      attempt += 1;
      timer = setTimeout(() => void poll(), BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
    };

    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [campaignId, filmRunId]);

  return data;
}
