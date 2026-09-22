"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { ConsentDraft, ProductFacts, PublicationStatus, SourceMedia } from "@/server/types";

export type SnapshotDecision = "allow" | "block" | "pending";
export type SnapshotStage = "briefed" | "policy-check" | "ready" | "generating" | "delivered";

export interface SnapshotBlocker {
  code: string;
  message: string;
  evidenceRefs: string[];
}

export interface SnapshotPreflight {
  decision: SnapshotDecision;
  checkedAt: string | null;
  blockerCount: number;
  blockers: SnapshotBlocker[];
  allowedClaims: string[];
  knowledgeAssetsConsulted: number;
  queriedRights: string[];
  queriedFacts: string[];
}

export interface SnapshotRights {
  passportId: string;
  platforms: string[];
  countries: string[];
  validUntil: string;
  transformations: string[];
  status: string;
  ual: string | null;
}

export interface SnapshotFacts {
  id: string;
  approvedClaims: string[];
  ual: string | null;
}

export interface SnapshotCampaign {
  id: string;
  title: string;
  status: string;
  /** Corrected status - the live preflight verdict wins over the stored label. */
  effectiveStatus: string;
  stage: SnapshotStage;
  platform: string;
  country: string;
  brand: string;
  productName: string;
  creatorId: string;
  creatorName: string;
  contextNote?: string;
  updatedAt: string;
  thumbnailUrl: string | null;
  generatedUrl: string | null;
  generatedMediaType: "image" | "video" | null;
  receiptsCount: number;
  /** Campaign evidence record, when approval published one. Null until then. */
  campaignUAL: string | null;
  /** Explicit state from the real publish result. Missing on legacy rows (non-public). */
  recordPublicationStatus: PublicationStatus | null;
  /** Stable public verification reference, set at approval. Null until then. */
  verificationRef: string | null;
  activeJobs: number;
  spentUsd: number;
  estimatedUsd: number;
  preflight: SnapshotPreflight;
  rights: SnapshotRights | null;
  facts: SnapshotFacts | null;
}

export interface SnapshotWarning {
  passportId: string;
  creatorName: string;
  validUntil: string;
  daysLeft: number;
  level: string;
  affectedCampaigns: string[];
}

export interface SnapshotPassport {
  id: string;
  creatorId: string;
  creatorName: string;
  status: string;
  validUntil: string;
  ual: string | null;
  platforms: string[];
  countries: string[];
  allowedTransformations: string[];
}

export interface SnapshotCreator {
  id: string;
  name: string;
  handle: string;
}

export interface SnapshotInvite {
  token: string;
  creatorId: string;
  status: "pending" | "completed";
  draft: ConsentDraft;
}

export interface OperationalMetrics {
  needsAttention: number;
  readyToProduce: number;
  outputsDelivered: number;
  spendProtected: number;
  totalSpent: number;
  blockedIds: string[];
  readyIds: string[];
}

export interface PipelineCount {
  stage: SnapshotStage;
  label: string;
  count: number;
  campaignIds: string[];
}

export interface SnapshotActivityItem {
  id: string;
  at: string;
  kind: string;
  summary: string;
  campaignId: string | null;
  campaignTitle: string | null;
}

export interface WorkspaceSnapshot {
  workspaceName: string | null;
  campaigns: SnapshotCampaign[];
  /** Archived rows for the Campaigns "Archived" filter. Excluded from metrics. */
  archivedCampaigns: SnapshotCampaign[];
  warnings: SnapshotWarning[];
  totalSpent: number;
  totalOutputs: number;
  metrics: OperationalMetrics;
  pipeline: PipelineCount[];
  activity: SnapshotActivityItem[];
  productFacts: ProductFacts[];
  sourceMedia: SourceMedia[];
  consentInvites: SnapshotInvite[];
  passports: SnapshotPassport[];
  creators: SnapshotCreator[];
}

/** Single TanStack Query identity for all authenticated workspace data. */
export const WORKSPACE_SNAPSHOT_KEY = ["workspace-snapshot"] as const;

export function fetchWorkspaceSnapshot(signal?: AbortSignal): Promise<WorkspaceSnapshot> {
  return api<WorkspaceSnapshot>("/api/workspace-snapshot", { signal });
}

/**
 * Authenticated workspace-data cache. Slightly stale data renders
 * immediately from cache, then refreshes quietly in the background:
 * cached rows stay visible during refetches (placeholderData keeps the
 * previous value), so pages must only show full-page skeletons when there
 * is no cached data at all (isPending with no data).
 */
export function useWorkspaceSnapshot() {
  return useQuery({
    queryKey: WORKSPACE_SNAPSHOT_KEY,
    queryFn: ({ signal }) => fetchWorkspaceSnapshot(signal),
    staleTime: 60_000,
    gcTime: 20 * 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    placeholderData: (previousData) => previousData
  });
}

/** Background-refresh the snapshot after a successful workspace write. */
export function useInvalidateWorkspaceSnapshot() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: WORKSPACE_SNAPSHOT_KEY });
}
