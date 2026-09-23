import { CAPABILITY_PRICE_MAP, type Campaign, type DerivativeReceipt, type ProductionJob, type ProductionStagePlan } from "@/server/types";

export interface Deliverable {
  id: "vertical" | "portrait" | "feed" | "landscape";
  title: string;
  spec: string;
  platforms: string;
  stages: ProductionStagePlan[];
}
export type DeliverableState = "ready" | "queued" | "running" | "partial" | "done" | "failed" | "review";

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
  const portrait = byFormat.get("4:5") ?? [];
  if (portrait.length > 0) {
    out.push({
      id: "portrait",
      title: "Portrait creative",
      spec: "4:5",
      platforms: "Instagram / Stories",
      stages: portrait
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

/**
 * Aggregate deliverable state from its stage jobs. No jobs yet = ready. A
 * fully generated deliverable with a delivery-blocked stage (e.g. ratio
 * mismatch) is "review", never "done" - the output is stored and editable
 * but not deliverable. Partial/active states keep existing behavior.
 */
export function deliverableState(
  jobs: ProductionJob[],
  stageIds: string[],
  blockedStageIds: Set<string> = new Set()
): DeliverableState {
  const mine = jobsForStages(jobs, stageIds);
  if (mine.length === 0) return "ready";
  const states = new Set(mine.map((j) => j.status));
  if (states.has("generating") || states.has("preview_ready") || states.has("storage_pending")) return "running";
  if (states.has("queued")) return states.size === 1 ? "queued" : "partial";
  if (states.has("failed") || states.has("cancelled") || states.has("storage_retry_needed")) {
    const settled = mine.every((j) => j.status === "failed" || j.status === "cancelled" || j.status === "storage_retry_needed" || j.status === "ready_to_share");
    return settled && mine.some((j) => j.status !== "ready_to_share") ? "failed" : "partial";
  }
  if (mine.every((j) => j.status === "ready_to_share")) {
    return stageIds.some((id) => blockedStageIds.has(id)) ? "review" : "done";
  }
  return "partial";
}

/**
 * Queue badge state for one job: a delivery-blocked ready_to_share output
 * (stored, reviewable, generation succeeded) shows as needs-review, never
 * Ready. All other statuses pass through untouched.
 */
export function queueStatusForJob(status: string, blocked: boolean): string {
  return blocked && status === "ready_to_share" ? "needs_review" : status;
}

/**
 * Variation eligibility: completed stored images, unchanged by delivery
 * blocking - a ratio-mismatched output remains a valid variations source
 * (the server re-verifies before dispatch). Generation status is the only
 * input; the receipt's delivery state never removes eligibility.
 */
export function canCreateVariations(
  receipt: Pick<DerivativeReceipt, "mediaType">,
  jobStatus: ProductionJob["status"] | undefined
): boolean {
  return receipt.mediaType === "image" && jobStatus === "ready_to_share";
}

/** Honest cost estimate for stages, same price map the workspace uses. */
export function estimateStages(stages: ProductionStagePlan[]): number {
  return stages.reduce((sum, stage) => {
    const price = CAPABILITY_PRICE_MAP[stage.capability];
    if (!price) return sum;
    return sum + (price.unit === "second" ? price.usd * 5 : price.usd);
  }, 0);
}

export interface LivePriceEntry {
  usd: number;
  unit: string;
}

export interface LiveEstimate {
  total: number;
  /** True only when every stage mapped to a live per-image/per-second price. */
  exact: boolean;
}

/**
 * Live Creative MCP estimate for the selected stages. Per-image prices map
 * directly; per-second prices use the 5s motion default. Anything else
 * (per-megapixel, per-token, unlisted) is not quotable live - the result is
 * marked inexact and the UI must say live pricing is unavailable rather
 * than present a number as a live quote.
 */
export function estimateStagesLive(
  stages: ProductionStagePlan[],
  live: Record<string, LivePriceEntry> | null
): LiveEstimate | null {
  if (!live) return null;
  let total = 0;
  let exact = true;
  for (const stage of stages) {
    const entry = live[stage.capability];
    if (entry && entry.unit === "image") {
      total += entry.usd;
    } else if (entry && entry.unit === "second") {
      total += entry.usd * 5;
    } else {
      exact = false;
    }
  }
  return { total, exact };
}

export function formatUsd(value: number): string {
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/**
 * Human-friendly capability label derived from structured fields only.
 * Substituted renders show "requested → actual"; legacy rows that baked an
 * arrow string into capability render as-is (displayed, never parsed).
 */
export function displayCapability(
  job: Pick<ProductionJob, "capability" | "requestedCapability" | "actualCapability">
): string {
  const actual = job.actualCapability;
  const requested = job.requestedCapability;
  if (actual && requested && actual !== requested) return `${requested} → ${actual}`;
  return actual ?? job.capability;
}

const STAGE_PLAIN: Record<string, string> = {
  keyframe: "campaign keyframe",
  "square-variation": "feed variation",
  "header-169": "landscape header",
  motion: "vertical motion creative"
};

/**
 * Plain-language activity for a job - "Creating vertical motion creative"
 * instead of MCP jargon. Falls back to the plan label for unknown stages.
 */
export function plainActivity(stageId: string, label: string, status: ProductionJob["status"]): string {
  const what = STAGE_PLAIN[stageId] ?? label.toLowerCase();
  if (status === "generating") return `Creating ${what}…`;
  if (status === "queued") return `Queued - ${what}`;
  if (status === "storage_pending") return `Generated - saving ${what} securely…`;
  if (status === "preview_ready") return `Checking ${what} quality…`;
  if (status === "ready_to_share") return `${what.charAt(0).toUpperCase() + what.slice(1)} ready`;
  if (status === "cancelled") return `${what.charAt(0).toUpperCase() + what.slice(1)} cancelled`;
  return `${what.charAt(0).toUpperCase() + what.slice(1)} failed`;
}

/**
 * Honest motion summary for pack review: separate short clips, never a
 * stitched film. Counts resolved clip lengths when they agree.
 */
export function describeMotionOutputs(durations: Array<number | null>): string {
  if (durations.length === 0) return "Images";
  if (durations.length === 1) return "Images + one short video clip";
  const known = durations.filter((d): d is number => typeof d === "number");
  if (known.length === durations.length && new Set(known).size === 1) {
    return `Images + ${durations.length} separate short clips · ${known[0]}s each`;
  }
  return `Images + ${durations.length} separate short clips`;
}

/** Image vs video makeup of a stage list - drives kind badges and cost notes. */
export function deliverableKind(stages: ProductionStagePlan[]): "image" | "video" | "mixed" {
  const kinds = new Set(stages.map((s) => (s.kind === "image-to-video" ? "video" : "image")));
  if (kinds.size > 1) return "mixed";
  return kinds.has("video") ? "video" : "image";
}

/** True when any stage has no catalogue price - estimates are then lower bounds. */
export function hasUnknownPrice(stages: ProductionStagePlan[]): boolean {
  return stages.some((s) => !CAPABILITY_PRICE_MAP[s.capability]);
}

/**
 * The one recommended starting point: the platform-matched deliverable's
 * image stages only. Video (motion) is never preselected - it is slower,
 * costlier, and a separate deliberate choice. Returns stage ids; empty
 * when there is nothing sensible to preselect (all done, or motion-only).
 */
export function recommendInitialStages(
  platform: string,
  deliverables: Deliverable[],
  succeededStageIds: Set<string>
): string[] {
  const match = (d: Deliverable): boolean => {
    const p = platform.toLowerCase();
    if (p === "instagram") return d.id === "feed";
    if (p === "tiktok") return d.id === "vertical";
    if (p === "youtube" || p === "linkedin") return d.id === "landscape";
    return false;
  };
  const target = deliverables.find(match) ?? deliverables[0];
  if (!target) return [];
  const imageStages = target.stages.filter(
    (s) => s.kind !== "image-to-video" && !succeededStageIds.has(s.id)
  );
  if (imageStages.length > 0) return imageStages.map((s) => s.id);
  // No image work left in the recommendation: fall back to any other
  // pending image stage rather than preselecting video or nothing useful.
  for (const d of deliverables) {
    const fallback = d.stages.filter(
      (s) => s.kind !== "image-to-video" && !succeededStageIds.has(s.id)
    );
    if (fallback.length > 0) return fallback.map((s) => s.id);
  }
  return [];
}
