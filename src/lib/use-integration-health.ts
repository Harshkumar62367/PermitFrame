"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "@/lib/api";

/** Client-safe shape returned by the low-priority integration-health route. */
export interface IntegrationHealth {
  dkg: {
    mode: string;
    healthy: boolean;
    blockchain?: string;
    detail?: string;
    endpoint?: string;
    state?: "checking" | "healthy" | "degraded" | "unavailable";
  };
  livepeer: {
    keyless: boolean;
    endpoint?: string;
    reachable?: boolean;
    detail?: string;
    state?: "checking" | "healthy" | "degraded" | "unavailable";
  };
}

const HEALTH_POLL_MS = 2_000;

/** Client-only slow-check threshold measured from the first health request. */
export const HEALTH_SLOW_MS = 20_000;

/** Neutral slow-check copy: never claims a service is offline. */
export const HEALTH_SLOW_COPY = "Service status is taking longer than expected. Refresh once or retry.";

/** The server's first SWR answer starts background probes; only poll while either is pending. */
export function integrationHealthPending(health: IntegrationHealth | null): boolean {
  return health === null || health.dkg.state === "checking" || health.livepeer.state === "checking";
}

export interface HealthPollerOptions {
  read: () => Promise<IntegrationHealth>;
  onUpdate: (health: IntegrationHealth | null, slow: boolean) => void;
  pollMs?: number;
  slowMs?: number;
}

export interface HealthPoller {
  stop: () => void;
  retry: () => void;
}

/**
 * Framework-free polling loop around /api/health: polls while either probe
 * is checking, stops once both settle, and flips a neutral slow flag after
 * `slowMs` while still pending. Slow never rewrites service state - the last
 * payload is preserved verbatim. Settled payloads always clear slow.
 */
export function createHealthPoller(options: HealthPollerOptions): HealthPoller {
  const pollMs = options.pollMs ?? HEALTH_POLL_MS;
  const slowMs = options.slowMs ?? HEALTH_SLOW_MS;
  let current: IntegrationHealth | null = null;
  let slowFired = false;
  let stopped = false;
  // Single-flight state: at most one read() is ever in flight, so an older
  // response can never land after - and overwrite - a newer settled result.
  // `generation` is a monotonic request id; only the latest generation may
  // write `current`, as explicit out-of-order protection.
  let inFlight: Promise<void> | null = null;
  let retryRequested = false;
  let generation = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let slowTimer: ReturnType<typeof setTimeout> | undefined;

  const emit = () => {
    if (!stopped) options.onUpdate(current, slowFired && integrationHealthPending(current));
  };

  const schedulePoll = () => {
    if (stopped) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      void refresh();
    }, pollMs);
  };

  const refresh = (): Promise<void> => {
    // Scheduled ticks coalesce while a read is active; retry() queues
    // exactly one follow-up via retryRequested instead.
    if (inFlight) return inFlight;
    const id = ++generation;
    const task = (async () => {
      let next: IntegrationHealth;
      try {
        next = await options.read();
      } catch {
        // A health read failing does not prove either integration is down.
        // Keep the last known snapshot and retry the low-priority read.
        if (stopped) return;
        if (id !== generation) return;
        schedulePoll();
        return;
      }
      if (stopped) return;
      if (id !== generation) return;
      current = next;
      if (integrationHealthPending(next)) {
        emit();
        schedulePoll();
      } else {
        if (slowTimer) clearTimeout(slowTimer);
        slowTimer = undefined;
        slowFired = false;
        emit();
      }
    })();
    inFlight = task;
    void task.then(() => {
      inFlight = null;
      if (stopped || !retryRequested) return;
      retryRequested = false;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      }
      void refresh();
    });
    return inFlight;
  };

  slowTimer = setTimeout(() => {
    slowFired = true;
    emit();
  }, slowMs);
  void refresh();

  return {
    stop() {
      stopped = true;
      retryRequested = false;
      if (pollTimer) clearTimeout(pollTimer);
      if (slowTimer) clearTimeout(slowTimer);
    },
    retry() {
      // Fresh /api/health read only: no reload, no production restart, no
      // DKG operations, no campaign writes. The slow threshold still runs
      // from the first request and is never reset here.
      if (stopped) return;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      }
      if (inFlight) {
        // A read is active: queue exactly one immediate follow-up read when
        // it settles instead of starting a parallel request.
        retryRequested = true;
        return;
      }
      void refresh();
    }
  };
}

export interface IntegrationHealthState {
  health: IntegrationHealth | null;
  isChecking: boolean;
  isSlow: boolean;
  retry: () => void;
}

/**
 * Reads the instant health snapshot, then polls only until the server-side
 * probes settle. This is necessary because the first SWR response is
 * intentionally `checking`; a one-shot client read would display that
 * neutral placeholder forever even after the probe completed.
 */
export function useIntegrationHealth(): IntegrationHealthState {
  const [health, setHealth] = useState<IntegrationHealth | null>(null);
  const [slow, setSlow] = useState(false);
  const pollerRef = useRef<HealthPoller | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const poller = createHealthPoller({
      read: () => apiGet<IntegrationHealth>("/api/health", controller.signal, 12_000),
      onUpdate: (next, slowNow) => {
        if (disposed) return;
        setHealth(next);
        setSlow(slowNow);
      }
    });
    pollerRef.current = poller;
    return () => {
      disposed = true;
      controller.abort();
      poller.stop();
      pollerRef.current = null;
    };
  }, []);

  const retry = useCallback(() => {
    // Fresh /api/health read only: no reload, no production restart, no
    // DKG operations, no campaign writes.
    pollerRef.current?.retry();
  }, []);

  const isChecking = integrationHealthPending(health);
  return { health, isChecking, isSlow: slow && isChecking, retry };
}
