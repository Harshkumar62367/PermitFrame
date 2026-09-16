"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  WORKSPACE_SNAPSHOT_KEY,
  useWorkspaceSnapshot,
  type OperationalMetrics,
  type PipelineCount,
  type SnapshotActivityItem,
  type SnapshotCampaign,
  type SnapshotWarning
} from "@/lib/use-workspace-snapshot";

export type {
  OperationalMetrics,
  PipelineCount,
  SnapshotActivityItem,
  SnapshotCampaign,
  SnapshotPreflight,
  SnapshotBlocker,
  SnapshotRights,
  SnapshotFacts,
  SnapshotWarning
} from "@/lib/use-workspace-snapshot";

/** Back-compat alias: overview rows are the snapshot campaign rows. */
export type OverviewCampaign = SnapshotCampaign;
export type OverviewWarning = SnapshotWarning;

export interface WorkspaceOverviewData {
  workspaceName: string | null;
  campaigns: OverviewCampaign[];
  warnings: OverviewWarning[];
  totalSpent: number;
  totalOutputs: number;
  metrics: OperationalMetrics;
  pipeline: PipelineCount[];
  activity: SnapshotActivityItem[];
}

export type OverviewStatus = "loading" | "ready" | "failed";

export interface OverviewState {
  status: OverviewStatus;
  data: WorkspaceOverviewData | null;
  error: string | null;
  retry: () => void;
  refresh: () => void;
}

/**
 * Workspace overview backed by the shared ["workspace-snapshot"] TanStack
 * Query cache. Cached rows stay visible during background refetches, so this
 * only reports "loading" when no cached data exists — never a full-page
 * skeleton on navigation between cached workspace views.
 */
export function useWorkspaceOverview(): OverviewState {
  const snapshot = useWorkspaceSnapshot();
  const queryClient = useQueryClient();

  const data: WorkspaceOverviewData | null = snapshot.data
    ? {
        workspaceName: snapshot.data.workspaceName,
        campaigns: snapshot.data.campaigns,
        warnings: snapshot.data.warnings,
        totalSpent: snapshot.data.totalSpent,
        totalOutputs: snapshot.data.totalOutputs,
        metrics: snapshot.data.metrics,
        pipeline: snapshot.data.pipeline,
        activity: snapshot.data.activity
      }
    : null;
  const error = snapshot.isError && !snapshot.data
    ? (snapshot.error instanceof Error ? snapshot.error.message : "Workspace overview failed to load.")
    : null;
  const status: OverviewStatus = data ? "ready" : error ? "failed" : "loading";

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: WORKSPACE_SNAPSHOT_KEY });
  }

  return {
    status,
    data,
    error,
    retry: refresh,
    refresh
  };
}
