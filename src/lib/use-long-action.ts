"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LONG_ACTION_SLOW_AFTER_MS, createSlowTimer, longActionErrorMessage } from "./long-action";

export interface LongActionCopy {
  /** Shown immediately while the action runs. */
  working: string;
  /** Shown after `slowAfterMs` - calm progress, never an error look. */
  slow: string;
  /** Shown only when our own client timeout fires - refresh-first recovery, never "failed". */
  timedOut: string;
  /** Last resort for non-Error throws. */
  fallback?: string;
}

export interface LongActionOutcome<T> {
  ok: boolean;
  value?: T;
  /** Resolved display message: null on success, error/recovery copy on failure. */
  message: string | null;
}

interface LongActionOptions {
  /** Client timeout budget passed to the api* call. Defaults to 120s. */
  timeoutMs?: number;
  /** Delay before the slow status reveals. Defaults to 5s. */
  slowAfterMs?: number;
}

/**
 * Reusable long-running mutation status. `execute` serializes runs (a second
 * call while busy is ignored), shows `working` immediately, reveals `slow`
 * after the delay, and cleans the timer up on success, failure, and unmount
 * (which also covers route change). Timeout recovery copy comes from
 * `longActionErrorMessage`, so components never hand-roll timer logic.
 */
export function useLongAction(copy: LongActionCopy, options?: LongActionOptions) {
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const slowAfterMs = options?.slowAfterMs ?? LONG_ACTION_SLOW_AFTER_MS;
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const cancelSlow = useRef<(() => void) | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelSlow.current?.();
      cancelSlow.current = null;
    };
  }, []);

  const clearSlow = useCallback(() => {
    cancelSlow.current?.();
    cancelSlow.current = null;
  }, []);

  const execute = useCallback(
    async <T,>(work: () => Promise<T>): Promise<LongActionOutcome<T>> => {
      if (busyRef.current) return { ok: false, message: null };
      busyRef.current = true;
      setBusy(true);
      setError(null);
      setStatus(copy.working);
      cancelSlow.current = createSlowTimer(() => {
        if (mounted.current) setStatus(copy.slow);
      }, slowAfterMs);
      try {
        const value = await work();
        if (!mounted.current) return { ok: true, value, message: null };
        clearSlow();
        busyRef.current = false;
        setStatus(null);
        setBusy(false);
        return { ok: true, value, message: null };
      } catch (e) {
        const message = longActionErrorMessage(
          e,
          copy.timedOut,
          copy.fallback ?? "Something went wrong - your input is preserved. Retry in a moment."
        );
        if (!mounted.current) return { ok: false, message };
        clearSlow();
        busyRef.current = false;
        setStatus(null);
        setError(message);
        setBusy(false);
        return { ok: false, message };
      }
    },
    [copy.working, copy.slow, copy.timedOut, copy.fallback, slowAfterMs, clearSlow]
  );

  return { busy, status, error, timeoutMs, execute };
}
