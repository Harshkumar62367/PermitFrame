"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiGet } from "@/lib/api";

export interface BootstrapCampaign {
  id: string;
  title: string;
  status: string;
  platform: string;
  country: string;
  demoNote?: string;
  updatedAt: string;
}

export interface BootstrapCreator {
  id: string;
  name: string;
  handle: string;
}

export interface BootstrapSnapshot {
  campaigns: BootstrapCampaign[];
  creators: BootstrapCreator[];
  dkg: { mode: string; healthy: boolean; detail: string; blockchain?: string };
  livepeer: { endpoint: string; keyless: boolean };
}

export type BootstrapState =
  | { status: "loading"; snapshot: null; error: null; refresh: () => void }
  | { status: "ready"; snapshot: BootstrapSnapshot; error: null; refresh: () => void }
  | { status: "failed"; snapshot: null; error: string; refresh: () => void };

const BootstrapContext = createContext<BootstrapState>({
  status: "loading",
  snapshot: null,
  error: null,
  refresh: () => undefined
});

// Module-level promise cache: every consumer shares one in-flight request,
// so N components never fire N identical bootstrap fetches.
let inflight: Promise<BootstrapSnapshot> | null = null;
function fetchSnapshot(signal: AbortSignal): Promise<BootstrapSnapshot> {
  if (!inflight) {
    inflight = apiGet<BootstrapSnapshot>("/api/bootstrap", signal).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/**
 * Single shared workspace snapshot (campaigns, creators, DKG + Livepeer
 * health). Mount once in the app layout; pages consume via useBootstrap().
 */
export function BootstrapProvider({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState<BootstrapSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const generationRef = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    const controller = new AbortController();
    const epoch = generation;
    fetchSnapshot(controller.signal).then(
      (data) => {
        if (mounted.current && epoch === generationRef.current) {
          setSnapshot(data);
          setError(null);
        }
      },
      (cause) => {
        if (mounted.current && epoch === generationRef.current && !(cause instanceof DOMException && cause.name === "AbortError")) {
          setError(cause instanceof Error ? cause.message : "Workspace failed to load.");
        }
      }
    );
    return () => {
      // Abort stale request on unmount / refresh; keep last good snapshot.
      controller.abort();
    };
  }, [generation]);

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const refresh = useCallback(() => {
    generationRef.current += 1;
    setGeneration(generationRef.current);
  }, []);

  const value = useMemo<BootstrapState>(() => {
    if (snapshot) return { status: "ready", snapshot, error: null, refresh };
    if (error) return { status: "failed", snapshot: null, error, refresh };
    return { status: "loading", snapshot: null, error: null, refresh };
  }, [snapshot, error, refresh]);

  return <BootstrapContext.Provider value={value}>{children}</BootstrapContext.Provider>;
}

export function useBootstrap(): BootstrapState {
  return useContext(BootstrapContext);
}
