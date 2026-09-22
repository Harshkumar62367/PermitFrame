"use client";

import { useEffect, useRef, useState } from "react";
import { apiGet } from "@/lib/api";

export interface RunJobState {
  id: string;
  stageId: string;
  status: string;
  outputUrl: string | null;
  costUsd: number | null;
  error: string | null;
}

export interface RunStatusResponse {
  ok: boolean;
  run: { id: string; status: string; note?: string; estimateUsd?: number | null; spendCapUsd?: number } | null;
  stages: { stageId: string; label: string; status: string; costUsd: number | null; estimateUsd: number | null }[];
  jobs: RunJobState[];
  progress: { ready: number; total: number };
  estimateTotal: number | null;
  actualTotal: number;
  spendCapUsd?: number;
}

const BACKOFF_MS = [2000, 4000, 8000, 15000, 30000];

function signatureOf(d: RunStatusResponse): string {
  return JSON.stringify([d.run?.status, d.jobs.map((j) => `${j.id}:${j.status}:${j.outputUrl ?? ""}`)]);
}

/**
 * Follows one production run with backoff polling (2s → 30s) while it is
 * active. Stops on terminal runs, never polls settled work, and cleans up
 * timers + in-flight requests on unmount or run change. The campaign
 * detail refresh fires only when job states actually change, so idle
 * pages stay quiet.
 */
export function useRunProgress(
  campaignId: string,
  runId: string | null,
  onChanged: () => Promise<void>
): RunStatusResponse | null {
  const [data, setData] = useState<RunStatusResponse | null>(null);
  const lastSig = useRef<string | null>(null);
  const changedRef = useRef(onChanged);

  useEffect(() => {
    changedRef.current = onChanged;
  }, [onChanged]);

  useEffect(() => {
    if (!runId) return;
    lastSig.current = null;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const controller = new AbortController();

    const poll = async (): Promise<void> => {
      try {
        const d = await apiGet<RunStatusResponse>(
          `/api/campaigns/${campaignId}/runs/${runId}`,
          controller.signal,
          15000
        );
        if (cancelled) return;
        setData(d);
        const sig = signatureOf(d);
        if (sig !== lastSig.current) {
          lastSig.current = sig;
          void changedRef.current().catch(() => undefined);
        }
        if (d.run?.status !== "active") return; // terminal: stop polling
        attempt = 0; // active runs with fresh data stay on the fast cadence
      } catch {
        if (cancelled) return;
        attempt += 1;
      }
      if (!cancelled) {
        timer = setTimeout(() => void poll(), BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [campaignId, runId]);

  return runId ? data : null;
}
