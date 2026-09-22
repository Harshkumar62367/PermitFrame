"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface DkgHealth {
  mode: string;
  healthy: boolean;
  endpoint?: string;
  blockchain?: string;
  detail: string;
}

export interface DkgAsset {
  ual: string;
  evidenceUri?: string;
  explorerUrl: string;
  name: string;
  content: Record<string, unknown>;
  publishedAt: string;
  mode: string;
}

export interface DkgGraph {
  health: DkgHealth;
  assets: DkgAsset[];
}

/** Deliberately separate from ["workspace-snapshot"]: slow DKG reads live
 *  here so they never block app navigation. */
export const DKG_GRAPH_KEY = ["dkg-graph"] as const;

export function fetchDkgGraph(signal?: AbortSignal): Promise<DkgGraph> {
  return api<DkgGraph>("/api/dkg", { signal });
}

/**
 * Cached graph view with quiet background refresh. Cached rows render
 * immediately; refetches never replace them with skeletons. SPARQL console
 * queries and all policy actions (preflight, publish, renew, revoke,
 * approve) always hit the live adapter at action time - cached graph data
 * is never presented as live policy truth.
 * Window-focus refetch stays off: DKG reads can be slow and must never fire
 * just because the tab regained focus.
 */
export function useDkgGraph() {
  return useQuery({
    queryKey: DKG_GRAPH_KEY,
    queryFn: ({ signal }) => fetchDkgGraph(signal),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    placeholderData: (previousData) => previousData
  });
}

/** Mark the cached graph stale after a publish-type write (no fetch fires
 *  unless the graph page is mounted; it background-refreshes on next visit). */
export function useInvalidateDkgGraph() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: DKG_GRAPH_KEY });
}
