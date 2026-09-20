"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiGet } from "@/lib/api";
import { WORKSPACE_SNAPSHOT_KEY, type WorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import type { Campaign, PermissionPassport, ProductFacts, SourceMedia } from "@/server/types";

export interface CampaignDetail {
  campaign: Campaign;
  sourceMedia: SourceMedia | null;
  passport: PermissionPassport | null;
  productFacts: ProductFacts | null;
  deletion: {
    deletable: boolean;
    archiveAvailable: boolean;
    reasons: string[];
    busy: boolean;
    force: { allowed: boolean; busy: boolean; reasons: string[]; warnings: string[] };
  };
}

export const campaignDetailKey = (id: string) => ["campaign", id] as const;

function fetchCampaignDetail(id: string, signal?: AbortSignal): Promise<CampaignDetail> {
  return apiGet<CampaignDetail>(`/api/campaigns/${id}`, signal);
}

/**
 * Campaign detail cache. Correctness first: the server response is always
 * the source of truth — the snapshot only warms the fetch (prefetch on
 * hover) so opens feel instant, never a substitute for real jobs/receipts.
 * Cached details survive back-navigation (stale 30s, background-refetch).
 */
export function useCampaignDetail(id: string) {
  return useQuery({
    queryKey: campaignDetailKey(id),
    queryFn: ({ signal }) => fetchCampaignDetail(id, signal),
    staleTime: 30_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    // A missing campaign stays missing: never retry 4xx (one fast 404, not
    // four slow requests with backoff). Transient failures retry at most once.
    retry: (count, error) => {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
      return count < 1;
    },
    placeholderData: (previousData) => previousData
  });
}

/** Warm the detail cache (hover intent). Never renders — only fetches. */
export function usePrefetchCampaignDetail() {
  const queryClient = useQueryClient();
  return (id: string) => {
    void queryClient.prefetchQuery({
      queryKey: campaignDetailKey(id),
      queryFn: ({ signal }) => fetchCampaignDetail(id, signal),
      staleTime: 30_000
    });
    // Touch the snapshot too so a cold list warms alongside the detail.
    void queryClient.prefetchQuery({ queryKey: WORKSPACE_SNAPSHOT_KEY, staleTime: 60_000 });
  };
}

export type { WorkspaceSnapshot };
