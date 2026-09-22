import type { Campaign, ProductionJob } from "../types";
import { isUsableOutputUrl } from "./plan-dag";
import { writeWorkspace } from "./run-store";
import { withCampaignLock } from "./mutex";
import { nowIso } from "../store";
import { finalizeDispatchedJob } from "./run-finalize";
import { failPreservationTool } from "./run-dispatch";

/**
 * Provider polling: progress-hold probing, timeout guards, per-job poll
 * routing (including async preservation-handle attribution), and terminal
 * state decisions. Depends on finalize (outcome recording) and dispatch
 * (preservation-tool exhaustion) - never submit or lifecycle.
 */

export type JobNextAction = "poll" | "submit" | "ignore";

/**
 * Resume-safe per-job action: a generating job holding a provider id is
 * polled (never re-submitted - no duplicate paid jobs); queued or stale
 * rows without an id submit; everything else is ignored.
 */
export function nextJobAction(job: ProductionJob): JobNextAction {
  if (job.status === "generating" && job.livepeerJobId) return "poll";
  if (job.status === "queued") return "submit";
  if (job.status === "generating" && !job.outputUrl && !job.livepeerJobId) return "submit";
  return "ignore";
}

export interface PumpResult {
  pumped: boolean;
  reason?: string;
}

export interface PumpOptions {
  runId?: string;
  /** Max wall-clock for one pump pass (short for status polls, long detached). */
  budgetMs?: number;
  /**
   * Provider progress-hold seconds per in-flight job. subscribe_progress
   * caps at 25s; the status route uses STATUS_PUMP (short) so a GET never
   * outlives the 15s browser timeout, while detached pumps wait longer.
   */
  progressHoldSeconds?: number;
  /**
   * Status GETs are strictly read/poll-only: allowDispatch false disables
   * new create_media submits (only existing provider ids are polled).
   * Defaults true for detached/produce pumps.
   */
  allowDispatch?: boolean;
  /**
   * Re-fire persist workers for stranded preview jobs. Defaults true;
   * status mode disables it (non-blocking read) and relies on the detached
   * pump the route triggers alongside.
   */
  allowPreviewResume?: boolean;
}

/**
 * Status-route pump budget: 4s wall-clock with 3s progress holds and a
 * shared per-probe deadline (hold + 4s slack), no dispatch, no blocking
 * resume - worst case lands around 11s, inside the 15s UI request timeout
 * (typical path ≈ 3-4s). Detached pumps use longer holds and full dispatch
 * via explicit PumpOptions.
 */
export const STATUS_PUMP: Required<Pick<PumpOptions, "budgetMs" | "progressHoldSeconds">> & {
  allowDispatch: false;
  allowPreviewResume: false;
} = {
  budgetMs: 4000,
  progressHoldSeconds: 3,
  allowDispatch: false,
  allowPreviewResume: false
};

/** Clamp a progress hold to the provider-supported 1-25s window. */
export function resolveProgressHold(value: number | undefined, fallback = 20): number {
  const n = value === undefined ? fallback : value;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(25, Math.max(1, Math.round(n)));
}

/** Inter-pass pause. Exported for the pump orchestrator (not public API). */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Provider probe without state: progress hold first, status endpoint fallback. No DB. */
export async function pollProviderJob(
  client: import("./mcp-client").LivepeerMcpClient,
  providerJobId: string,
  holdSeconds: number
): Promise<import("./mcp-client").MediaStatusResult> {
  // Shared deadline for both attempts: even a hung provider connection
  // cannot outlive hold + slack, so status pumps stay inside their budget.
  const hold = resolveProgressHold(holdSeconds);
  const deadline = Date.now() + hold * 1000 + 4000;
  const remaining = (): number => Math.max(0, deadline - Date.now());
  try {
    return await withTimeout(client.waitForProgress(providerJobId, hold), remaining());
  } catch {
    return withTimeout(client.getMediaStatus(providerJobId), remaining());
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("probe timeout")), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Poll one in-flight job: progress call first, status endpoint fallback.
 * Returns true on state change. Exported for the pump orchestrator only;
 * route and test code poll through pumpRun / the status snapshot.
 */
export async function pollJob(
  client: import("./mcp-client").LivepeerMcpClient,
  workspaceId: string,
  campaign: Campaign,
  job: ProductionJob,
  holdSeconds: number
): Promise<boolean> {
  if (!job.livepeerJobId) return false;
  let status;
  try {
    status = await pollProviderJob(client, job.livepeerJobId, holdSeconds);
  } catch {
    return false; // transient probe failure - next pump retries, nothing lost
  }
  // Preservation-owned provider job: the handle was persisted by
  // trackPreservationJob, so this poll attributes to the preservation tool
  // (never to a create_media render that never happened).
  const pendingTool =
    job.requestMeta?.preservationPendingTool === "place_subject" ||
    job.requestMeta?.preservationPendingTool === "create_variations"
      ? job.requestMeta.preservationPendingTool
      : undefined;
  if (status.terminal && status.outputUrl && isUsableOutputUrl(status.outputUrl)) {
    await finalizeDispatchedJob(workspaceId, campaign, job, {
      providerUrl: status.outputUrl,
      livepeerJobId: status.jobId ?? job.livepeerJobId,
      costUsd: status.costUsd,
      capability: status.capability,
      ...(pendingTool
        ? {
            modelNote: pendingTool === "place_subject" ? "place_subject operation succeeded" : "create_variations (explicit refinement)",
            preservation: {
              actualCapability: pendingTool,
              // A tracked variation derives from the selected output:
              // provenance, never a preservation claim.
              evidenceLevel: pendingTool === "place_subject" ? ("subject-preserving" as const) : ("none" as const),
              providerOperationSucceeded: true
            }
          }
        : {
            // No preservation handle was ever pending, so this poll
            // delivered a standard guided render - correct the claim-time
            // intent stamp (which names the resolved tool) to what actually
            // rendered. Any recorded fallback reason survives the merge.
            preservation: {
              actualCapability: "create_media" as const,
              evidenceLevel: "source-guided" as const,
              providerOperationSucceeded: true
            }
          })
    });
    return true;
  }
  if (status.terminal && !status.outputUrl) {
    if (pendingTool) {
      // Confirmed terminal preservation failure: exhaust the tool and
      // re-queue for exactly one guided render. The dead handle is gone,
      // so this is the only fallback - never a second preservation call.
      await failPreservationTool(
        workspaceId,
        campaign.id,
        job.id,
        pendingTool,
        `Preservation job ended (${status.status}) without an output - rendered as a guided output instead.`
      );
      return true;
    }
    await withCampaignLock(campaign.id, () =>
      writeWorkspace(workspaceId, (d) => {
        const j = d.campaigns.find((x) => x.id === campaign.id)?.jobs.find((x) => x.id === job.id);
        if (j && j.status === "generating") {
          j.status = "failed";
          j.error = `Livepeer job ended (${status.status}) without an output.`;
          j.finishedAt = nowIso();
        }
      })
    );
    return true;
  }
  return false;
}
