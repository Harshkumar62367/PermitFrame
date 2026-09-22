import type { FilmPlan, FilmScene } from "./film-plan";

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
  url: string;
  status?: string;
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
  costUsd?: number;
  /** Final reel file URL - HTTPS-verified before ready, never otherwise. */
  reelUrl?: string;
  /** Actual scene outputs - provider-reported rows only, never planned stills. */
  sceneOutputs: FilmSceneOutput[];
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
export function nextFilmAction(run: Pick<FilmRun, "status" | "providerJobId" | "providerStatus">): FilmNextAction {
  if (run.status === "ready" || run.status === "failed" || run.status === "cancelled") return "none";
  if (run.providerJobId) {
    const gate = (run.providerStatus ?? "").toLowerCase();
    if (/(awaiting_confirmation|awaiting confirmation|needs_confirmation|needs confirmation|\bstaged\b)/.test(gate)) {
      return "confirm_staged";
    }
    return "poll";
  }
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

/** Display label for the film lifecycle, including pre-run Planning. */
export function filmDisplayLabel(run: Pick<FilmRun, "status"> | null): string {
  if (!run) return "Planning";
  return FILM_RUN_LABELS[run.status];
}
