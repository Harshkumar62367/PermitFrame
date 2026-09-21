import type { Campaign, Database } from "./types";
import { isActiveJobStatus } from "./types";

/**
 * Campaign deletion rules. Pure functions over domain objects (no session, no
 * I/O) so the semantics are unit-testable; routes wrap them in the owner gate
 * plus authenticated workspace reads/writes.
 *
 * - Hard delete is allowed ONLY for workspace-local drafts: no generated
 *   assets, no share link, no anchored/finalized proof, no running jobs.
 *   It removes the campaign row, its jobs/receipts/plan and its
 *   verification reference, and records a tombstone. Workspace activity
 *   entries that mention it stay (audit history); nothing on the DKG is
 *   ever touched — deletable campaigns by definition have no public proof.
 * - Anything with generated assets, a share link, or an anchored record is
 *   archive-only: the row stays readable (detail page, share link, history)
 *   but leaves Campaigns/Overview/metrics.
 * - Archived rows are never hard-deleted: they ARE the audit history.
 * - Active (queued/running) jobs block both operations until they settle, so
 *   a background worker can never write into a removed row mid-flight.
 */

export interface DeletionEligibility {
  /** Hard delete is safe. */
  deletable: boolean;
  /** Archive is available (always true except when active jobs are running). */
  archiveAvailable: boolean;
  /** Human-readable reasons when deletable is false. */
  reasons: string[];
  /** True while jobs are queued/running: retry after they settle. */
  busy: boolean;
}

export function deletionEligibility(campaign: Campaign): DeletionEligibility {
  const reasons: string[] = [];
  const activeJobs = campaign.jobs.filter((j) => isActiveJobStatus(j.status));
  if (activeJobs.length > 0) {
    return {
      deletable: false,
      archiveAvailable: false,
      reasons: [`Production is still running (${activeJobs.length} active job${activeJobs.length === 1 ? "" : "s"}) — wait until it finishes, then delete or archive.`],
      busy: true
    };
  }
  if (campaign.status === "archived") {
    return {
      deletable: false,
      archiveAvailable: false,
      reasons: ["Archived campaigns are kept for audit history and cannot be deleted."],
      busy: false
    };
  }
  // NOTE: permanent removal of an archived record exists as an explicit,
  // flag-gated last resort (forceDeleteEligibility below) — never here, so
  // ordinary delete flows and UIs can never stumble into destroying history.
  const hasAssets = campaign.receipts.length > 0 || campaign.jobs.some((j) => j.status === "ready_to_share");
  if (hasAssets) {
    reasons.push(
      `It has generated assets (${campaign.receipts.length} output${campaign.receipts.length === 1 ? "" : "s"}) — archive it so the audit history stays intact.`
    );
  }
  if (campaign.shareToken) {
    reasons.push("It has an active client-review link — archive it instead so the link keeps resolving to the audit record.");
  }
  if (
    campaign.publicationStatus === "anchored" ||
    (campaign.campaignUAL ?? "").length > 0 ||
    (campaign.verificationRef ?? "").length > 0
  ) {
    reasons.push("It has a finalized public proof record — archive it so verification history stays intact.");
  }
  return { deletable: reasons.length === 0, archiveAvailable: true, reasons, busy: false };
}

/**
 * Last-resort permanent removal of an ARCHIVED record only. The normal path
 * above never allows this; callers must pass an explicit force flag (owner
 * only, hidden UI, type-to-confirm) precisely because it destroys audit
 * history: the workspace row, its jobs/receipts/plan and its share link go
 * away. What survives: workspace activity events, verification snapshots
 * (public proof stays verifiable — it was the point of publishing), and
 * ledger data (never touched). Active jobs block even force: a background
 * worker must never write into a removed row mid-flight.
 */
export interface ForceDeleteEligibility {
  allowed: boolean;
  busy: boolean;
  reasons: string[];
  warnings: string[];
}

export function forceDeleteWarnings(campaign: Campaign): string[] {
  const warnings: string[] = [
    "The workspace record is removed permanently — brief, jobs, generated outputs and plan."
  ];
  if (campaign.receipts.length > 0) {
    warnings.push(
      `${campaign.receipts.length} generated output${campaign.receipts.length === 1 ? "" : "s"} will no longer resolve from this workspace.`
    );
  }
  if (campaign.shareToken) {
    warnings.push("The client-review link breaks immediately (anyone holding it gets not-found).");
  }
  if ((campaign.verificationRef ?? "").length > 0 || (campaign.campaignUAL ?? "").length > 0) {
    warnings.push(
      "Public verification snapshots stay published and verifiable — archiving's proof purpose survives, only this workspace's copy goes."
    );
  }
  warnings.push("Workspace activity entries that mention it stay. This cannot be undone.");
  return warnings;
}

export function forceDeleteEligibility(campaign: Campaign): ForceDeleteEligibility {
  const activeJobs = campaign.jobs.filter((j) => isActiveJobStatus(j.status));
  if (activeJobs.length > 0) {
    return {
      allowed: false,
      busy: true,
      reasons: [`Production is still running (${activeJobs.length} active job${activeJobs.length === 1 ? "" : "s"}) — force delete is blocked until it settles.`],
      warnings: []
    };
  }
  if (campaign.status !== "archived") {
    return {
      allowed: false,
      busy: false,
      reasons: ["Force delete applies only to archived records — use the normal delete or archive flow."],
      warnings: []
    };
  }
  return { allowed: true, busy: false, reasons: [], warnings: forceDeleteWarnings(campaign) };
}

export class CampaignNotFoundError extends Error {
  constructor(id: string) {
    super(`Campaign ${id} was not found. It may have been removed or the link is wrong.`);
    this.name = "CampaignNotFoundError";
  }
}

/** Retry of a DELETE for an already-deleted campaign — success, not an error. */
export interface AlreadyDeleted {
  deleted: true;
  alreadyDeleted: true;
  title: string;
}

/** The campaign was hard-deleted earlier: replays must not resurrect it. */
export class CampaignDeletedError extends Error {
  constructor(readonly title: string) {
    super(`“${title}” was deleted. Start a fresh submission to create a new campaign.`);
    this.name = "CampaignDeletedError";
  }
}

/** Only the workspace owner may delete or archive. Mapped to 403. */
export class WorkspaceOwnerRequiredError extends Error {
  constructor() {
    super("Only the workspace owner may delete or archive campaigns.");
    this.name = "WorkspaceOwnerRequiredError";
  }
}

/** Eligible neither for delete (nor archive while busy). Mapped to 409. */
export class CampaignProtectedError extends Error {
  constructor(readonly reasons: string[], readonly archiveAvailable: boolean) {
    super(reasons.join(" "));
    this.name = "CampaignProtectedError";
  }
}

function tombstones(db: Database): Database["deletedCampaigns"] {
  // Legacy workspace rows predate the list — treat as empty, never crash.
  if (!db.deletedCampaigns) db.deletedCampaigns = [];
  return db.deletedCampaigns;
}

export function isDeleted(db: Database, id: string): boolean {
  return tombstones(db).some((t) => t.id === id);
}

export function deletedTitle(db: Database, id: string): string | undefined {
  return tombstones(db).find((t) => t.id === id)?.title;
}

/**
 * Remove the campaign row + its jobs/receipts/plan from workspace state and
 * record a tombstone. Events that mention it stay (audit history).
 * Idempotent: deleting an already-tombstoned id succeeds without touching
 * anything. Throws CampaignNotFoundError for ids never seen.
 */
export function applyDeleteToDb(
  db: Database,
  id: string,
  now: string,
  eventId: string
): { deleted: true; alreadyDeleted: boolean; title: string } {
  const existing = tombstones(db).find((t) => t.id === id);
  if (existing) return { deleted: true, alreadyDeleted: true, title: existing.title };
  const index = db.campaigns.findIndex((c) => c.id === id);
  if (index < 0) throw new CampaignNotFoundError(id);
  const [removed] = db.campaigns.splice(index, 1);
  tombstones(db).push({ id, title: removed.title, deletedAt: now });
  db.events.push({
    id: eventId,
    at: now,
    kind: "campaign.deleted",
    summary: `Campaign “${removed.title}” was deleted (workspace-local draft data removed; shared proof untouched — none existed).`,
    refs: [id]
  });
  return { deleted: true, alreadyDeleted: false, title: removed.title };
}

/**
 * Archive the campaign row in place: it leaves lists/metrics but stays
 * readable (detail page, share link, timeline). Idempotent: archiving an
 * already-archived campaign succeeds without touching anything.
 */
export function applyArchiveToDb(
  db: Database,
  id: string,
  now: string,
  eventId: string
): { archived: true; alreadyArchived: boolean; title: string } {
  const campaign = db.campaigns.find((c) => c.id === id);
  if (!campaign) throw new CampaignNotFoundError(id);
  if (campaign.status === "archived") return { archived: true, alreadyArchived: true, title: campaign.title };
  campaign.status = "archived";
  campaign.updatedAt = now;
  db.events.push({
    id: eventId,
    at: now,
    kind: "campaign.archived",
    summary: `Campaign “${campaign.title}” was archived (kept for audit history; hidden from lists).`,
    refs: [id]
  });
  return { archived: true, alreadyArchived: false, title: campaign.title };
}
