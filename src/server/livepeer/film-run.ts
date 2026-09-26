import type { FilmPlan, FilmScene } from "./film-plan";
import { MAX_PROVIDER_WATCHDOG_SECONDS, providerWatchdogSeconds } from "./provider-watchdog";

/**
 * Durable FilmRun: one paid provider film job owned by exactly one run,
 * persisted on the campaign document (optional `filmRuns` - no migration).
 * Separate from ProductionRun/ProductionJob on purpose: the short-clip
 * runner, its queue semantics, receipts, and DKG proof paths never read
 * or write these rows, so film execution cannot distort them.
 *
 * States (UI labels in FILM_RUN_LABELS): confirmed → submitting →
 * generating_scenes → assembling_reel → ready, plus failed / cancelled.
 * "Planning" is the absence of a run (draft stage), never a stored state.
 */

export type FilmRunStatus =
  | "confirmed"
  | "submitting"
  | "generating_scenes"
  | "assembling_reel"
  | "ready"
  | "failed"
  | "cancelled";

export const FILM_RUN_LABELS: Record<FilmRunStatus, string> = {
  confirmed: "Confirmed",
  submitting: "Submitting",
  generating_scenes: "Generating scenes",
  assembling_reel: "Assembling reel",
  ready: "Ready",
  failed: "Failed",
  cancelled: "Cancelled"
};

/** Provider-reported scene output: only rows the provider actually returned. */
export interface FilmSceneOutput {
  index: number;
  title?: string;
  /** A scene may report progress before the provider has published its URL. */
  url?: string;
  status?: string;
  /** Async image-to-video provider job for this scene only. */
  providerJobId?: string;
  lastProviderJobId?: string;
  /** Incremented only when an explicit Resume retries a failed scene. */
  attempt?: number;
  costUsd?: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

/**
 * Source-preservation provenance for film scenes: the confirmed prompts
 * reference approved source media in TEXT, but no reference image is ever
 * sent and no preservation tool runs - evidence stays "none" with the note
 * saying exactly that. Never upgraded beyond the recorded evidence.
 */
export interface FilmPreservation {
  requested: "source-guided-generation";
  evidenceLevel: "none";
  note: string;
}

export interface FilmRun {
  id: string;
  campaignId: string;
  /** Confirmed plan snapshot (title/target/aspect/cap as approved). */
  filmTitle: string;
  targetDurationSeconds: FilmPlan["targetDurationSeconds"];
  aspectRatio: FilmPlan["aspectRatio"];
  /** User-confirmed cap: a maximum, never an estimate or quote. */
  budgetCapUsd: number;
  /** sha256 over the canonical confirmed scene list. */
  sceneFingerprint: string;
  /** Planned scene definitions (what was confirmed). */
  plannedScenes: FilmScene[];
  /** Approved source record bound to this run; its delivery URL is never stored.
   * Optional only for legacy runs, which fall back to the campaign selection. */
  sourceMediaId?: string;
  /** Brief snapshot used to keep each source-bound scene on the approved product. */
  brand?: string;
  productName?: string;
  creativeBrief?: string;
  /** Stable per-run provider tag (session_id); reused on every retry. */
  providerSessionId: string;
  status: FilmRunStatus;
  /** Last provider status text (or staged/awaiting-confirmation gate). */
  providerStatus?: string;
  /** Provider estimate when reported (compared against the cap, never a quote). */
  estimateUsd?: number;
  /** What was asked for: provider-routed creative-job scenes (no model pick). */
  requestedCapability: string;
  /** What actually rendered, when the provider reports it. */
  actualCapability?: string;
  /** Owned provider job id (cjob_*); persisted before any poll/confirm. */
  providerJobId?: string;
  lastProviderJobId?: string;
  /** Async job for stitching already verified scene clips, if the provider returns one. */
  assemblyJobId?: string;
  assemblyClaimedAt?: string;
  /** Provider-hosted progress page. It is an inspector link, never a deliverable reel. */
  providerViewerUrl?: string;
  /** Durable claim made before the provider submit call.  It prevents a
   * second worker from submitting the same storyboard while the first call
   * is still awaiting the provider's acknowledgement. */
  submissionClaimedAt?: string;
  dispatchStartedAt?: string;
  providerBudgetSeconds?: number;
  dispatchBudgetSeconds?: number;
  dispatchDeadlineAt?: string;
  watchdogCancelAttemptedAt?: string;
  watchdogCancelConfirmed?: boolean;
  providerFailureKind?: string;
  costUsd?: number;
  /** Final reel file URL - HTTPS-verified before ready, never otherwise. */
  reelUrl?: string;
  /** Actual scene outputs - provider-reported rows only, never planned stills. */
  sceneOutputs: FilmSceneOutput[];
  /**
   * Burn-captions finishing jobs for the delivered reel (newest last).
   * Optional - runs delivered before finishing existed carry none.
   */
  captionJobs?: import("./film-captions").FilmCaptionJob[];
  /**
   * Narrated-reel finishing jobs for the delivered reel (newest last).
   * Optional - runs delivered before narration existed carry none.
   * Separate records from caption jobs, generation jobs, and receipts.
   */
  narrationJobs?: import("./narration-policy").FilmNarrationJob[];
  preservation: FilmPreservation;
  error?: string;
  /** Client-generated key: repeats replay this run, never a second paid job. */
  idempotencyKey?: string;
  providerCancelConfirmed?: boolean;
  providerCancelNote?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export type FilmNextAction = "submit" | "confirm_staged" | "poll" | "none";

/**
 * Resume-safe next action: a run holding a provider id is polled or
 * confirmed - never re-submitted (no duplicate paid jobs). A confirmed run
 * without an id submits. Terminal runs do nothing.
 */
export function nextFilmAction(run: Pick<FilmRun, "status" | "providerJobId" | "providerStatus"> & { submissionClaimedAt?: string }): FilmNextAction {
  if (run.status === "ready" || run.status === "failed" || run.status === "cancelled") return "none";
  if (run.providerJobId) {
    const gate = (run.providerStatus ?? "").toLowerCase();
    if (/(awaiting_confirmation|awaiting confirmation|needs_confirmation|needs confirmation|\bstaged\b)/.test(gate)) {
      return "confirm_staged";
    }
    return "poll";
  }
  // A provider submit is in flight.  Do not make another paid call just
  // because a status poll or another process sees the run first.
  if (run.submissionClaimedAt) return "none";
  return "submit";
}

/**
 * Cap gate before dispatch/confirm: a known provider estimate over the
 * confirmed maximum refuses - the scenes are never silently trimmed.
 * Unknown estimates pass (the provider enforces budget_usd itself and
 * refuses over-cap plans with budget_exceeded before spending).
 */
export function checkFilmCap(budgetCapUsd: number, estimateUsd: number | undefined): string | null {
  if (estimateUsd !== undefined && estimateUsd > budgetCapUsd) {
    return `Provider estimate $${estimateUsd.toFixed(2)} exceeds the confirmed $${budgetCapUsd.toFixed(2)} maximum - nothing was dispatched. Lower the plan or raise the cap with a new film plan.`;
  }
  return null;
}

/** Active (billable-or-pending) film runs for progress display. */
export function isActiveFilmStatus(status: FilmRunStatus): boolean {
  return status === "confirmed" || status === "submitting" || status === "generating_scenes" || status === "assembling_reel";
}

/**
 * A Campaign Film is one provider-side storyboard + reel assembly job, not
 * a short clip.  Give that handoff a film-sized window even when the provider
 * reports the generic short-job budget.  The provider's longer reported
 * budget is respected, still bounded by the global fifteen-minute ceiling.
 */
export const FILM_MIN_PROVIDER_WATCHDOG_SECONDS = 8 * 60;

export function filmProviderWatchdogSeconds(reportedBudgetSeconds?: number): number {
  return Math.min(
    MAX_PROVIDER_WATCHDOG_SECONDS,
    Math.max(FILM_MIN_PROVIDER_WATCHDOG_SECONDS, providerWatchdogSeconds(reportedBudgetSeconds))
  );
}

export function filmWatchdogDeadlineMs(run: Pick<FilmRun, "dispatchDeadlineAt" | "dispatchStartedAt" | "providerBudgetSeconds" | "dispatchBudgetSeconds">, now = Date.now()): number {
  const explicit = Date.parse(run.dispatchDeadlineAt ?? "");
  if (Number.isFinite(explicit)) return explicit;
  const anchor = Date.parse(run.dispatchStartedAt ?? "");
  const seconds = run.providerBudgetSeconds !== undefined
    ? filmProviderWatchdogSeconds(run.providerBudgetSeconds)
    : run.dispatchBudgetSeconds !== undefined && Number.isFinite(run.dispatchBudgetSeconds) && run.dispatchBudgetSeconds > 0
      ? Math.min(MAX_PROVIDER_WATCHDOG_SECONDS, Math.max(FILM_MIN_PROVIDER_WATCHDOG_SECONDS, run.dispatchBudgetSeconds))
      : filmProviderWatchdogSeconds();
  return Number.isFinite(anchor) ? anchor + seconds * 1000 : now + seconds * 1000;
}

export function isFilmWatchdogExpired(run: Pick<FilmRun, "status" | "dispatchDeadlineAt" | "dispatchStartedAt" | "providerBudgetSeconds" | "dispatchBudgetSeconds">, now = Date.now()): boolean {
  return isActiveFilmStatus(run.status) && filmWatchdogDeadlineMs(run, now) <= now;
}

/** Display label for the film lifecycle, including pre-run Planning. */
export function filmDisplayLabel(run: Pick<FilmRun, "status"> | null): string {
  if (!run) return "Planning";
  return FILM_RUN_LABELS[run.status];
}
