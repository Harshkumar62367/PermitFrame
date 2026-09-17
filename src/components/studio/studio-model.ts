import { CAPABILITY_PRICE_MAP, type Campaign, type DerivativeReceipt, type ProductionJob, type ProductionStagePlan } from "@/server/types";

export interface Deliverable {
  id: "vertical" | "feed" | "landscape";
  title: string;
  spec: string;
  platforms: string;
  stages: ProductionStagePlan[];
}

export type DeliverableState = "ready" | "queued" | "running" | "partial" | "done" | "failed";

/**
 * Groups the approved plan stages into the three selectable deliverables.
 * Derived from the live plan (not hardcoded): an image-only campaign has no
 * motion stage, so its vertical deliverable is keyframe-only.
 */
export function planDeliverables(campaign: Campaign): Deliverable[] {
  const plan = campaign.preflight?.plan ?? [];
  const byFormat = new Map<string, ProductionStagePlan[]>();
  for (const stage of plan) {
    const list = byFormat.get(stage.format) ?? [];
    list.push(stage);
    byFormat.set(stage.format, list);
  }
  const out: Deliverable[] = [];
  const vertical = byFormat.get("9:16") ?? [];
  if (vertical.length > 0) {
    out.push({
      id: "vertical",
      title: "Vertical social",
      spec: "9:16",
      platforms: "Reels / TikTok",
      stages: vertical
    });
  }
  const feed = byFormat.get("1:1") ?? [];
  if (feed.length > 0) {
    out.push({
      id: "feed",
      title: "Feed creative",
      spec: "1:1",
      platforms: "Instagram",
      stages: feed
    });
  }
  const landscape = byFormat.get("16:9") ?? [];
  if (landscape.length > 0) {
    out.push({
      id: "landscape",
      title: "Landscape",
      spec: "16:9",
      platforms: "YouTube / LinkedIn",
      stages: landscape
    });
  }
  return out;
}

export function jobsForStages(jobs: ProductionJob[], stageIds: string[]): ProductionJob[] {
  return jobs.filter((j) => stageIds.includes(j.stageId));
}

export function receiptsForStages(receipts: DerivativeReceipt[], jobs: ProductionJob[], stageIds: string[]): DerivativeReceipt[] {
  const jobIds = new Set(jobsForStages(jobs, stageIds).map((j) => j.id));
  return receipts.filter((r) => jobIds.has(r.jobId));
}

/** Aggregate deliverable state from its stage jobs. No jobs yet = ready. */
export function deliverableState(jobs: ProductionJob[], stageIds: string[]): DeliverableState {
  const mine = jobsForStages(jobs, stageIds);
  if (mine.length === 0) return "ready";
  const states = new Set(mine.map((j) => j.status));
  if (states.has("running")) return "running";
  if (states.has("queued")) return states.size === 1 ? "queued" : "partial";
  if (states.has("failed")) return mine.every((j) => j.status === "failed" || j.status === "succeeded") && mine.some((j) => j.status === "failed") ? "failed" : "partial";
  if (mine.every((j) => j.status === "succeeded")) return "done";
  return "partial";
}

/** Honest cost estimate for stages, same price map the workspace uses. */
export function estimateStages(stages: ProductionStagePlan[]): number {
  return stages.reduce((sum, stage) => {
    const price = CAPABILITY_PRICE_MAP[stage.capability];
    if (!price) return sum;
    return sum + (price.unit === "second" ? price.usd * 5 : price.usd);
  }, 0);
}

export function formatUsd(value: number): string {
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

const STAGE_PLAIN: Record<string, string> = {
  keyframe: "campaign keyframe",
  "square-variation": "feed variation",
  "header-169": "landscape header",
  motion: "vertical motion creative"
};

/**
 * Plain-language activity for a job — "Creating vertical motion creative"
 * instead of MCP jargon. Falls back to the plan label for unknown stages.
 */
export function plainActivity(stageId: string, label: string, status: ProductionJob["status"]): string {
  const what = STAGE_PLAIN[stageId] ?? label.toLowerCase();
  if (status === "running") return `Creating ${what}…`;
  if (status === "queued") return `Queued — ${what}`;
  if (status === "succeeded") return `${what.charAt(0).toUpperCase() + what.slice(1)} ready`;
  return `${what.charAt(0).toUpperCase() + what.slice(1)} failed`;
}
