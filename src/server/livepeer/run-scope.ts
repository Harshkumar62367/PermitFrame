import type {
  Campaign,
  ProductionJob,
  ProductionRun,
  ProductionStagePlan,
  StageFidelity,
  StageInputSource
} from "../types";
import {
  prerequisiteMessage,
  resolveStageInput,
  seedStageOutputs,
  type StageRunDecision
} from "./plan-dag";
import { isBackoffPending, placeSubjectMode } from "./run-retry";
import { failStageJobs } from "./pipeline";

/**
 * Run scope: exact-job versus legacy stage-scoped ownership, dispatch slot
 * selection, submit dedupe comparison, and dispatch-source ownership.
 * Imports only the tuning leaf (run-retry) plus dependency-neutral policy
 * modules - never dispatch, poll, submit, or lifecycle, so no cycle can
 * form in either direction.
 */

/* ------------------------- pure decision helpers ------------------------ */

export interface DispatchSlot {
  job: ProductionJob;
  inputUrl: string;
  resolvedInputSource: StageInputSource;
  sourceStageId?: string;
}

/**
 * Order-preserving dispatch selection: walk run decisions in dependency
 * order, taking runnable stages until in-flight + new fills the ceiling.
 * Jobs waiting out a persisted backoff window are skipped (resumed by a
 * later pump). Pure - concurrency and ordering are unit-testable.
 */
export function selectDispatchable(
  decisions: StageRunDecision[],
  jobs: ProductionJob[],
  activeCount: number,
  ceiling: number,
  now = Date.now()
): DispatchSlot[] {
  const slots: DispatchSlot[] = [];
  if (ceiling <= activeCount) return slots;
  for (const decision of decisions) {
    if (slots.length + activeCount >= ceiling) break;
    if (decision.action !== "run" || !decision.inputUrl) continue;
    const job = jobs.find(
      (j) =>
        j.stageId === decision.stage.id &&
        (j.status === "queued" || (j.status === "generating" && !j.outputUrl && !j.livepeerJobId))
    );
    if (!job || isBackoffPending(job, now)) continue;
    slots.push({
      job,
      inputUrl: decision.inputUrl,
      resolvedInputSource: decision.resolvedInputSource ?? decision.stage.inputSource,
      ...(decision.sourceStageId ? { sourceStageId: decision.sourceStageId } : {})
    });
  }
  return slots;
}

/** Exact-job scope present: this run addresses job ids, never stage ids. */
export function isExactRun(run: Pick<ProductionRun, "jobIds">): boolean {
  return !!run.jobIds && run.jobIds.length > 0;
}

/**
 * Run ownership predicate - the single gate for every run operation.
 * Exact runs own ONLY their listed job ids (a sibling sharing a stageId is
 * never owned); legacy runs own every job on their stages, unchanged.
 */
export function runOwnsJob(run: Pick<ProductionRun, "jobIds" | "stageIds">, job: Pick<ProductionJob, "id" | "stageId">): boolean {
  if (isExactRun(run)) return (run.jobIds as string[]).includes(job.id);
  return run.stageIds.includes(job.stageId);
}

/**
 * Dispatch slots for exact-job runs (variation/refinement derivatives).
 * One slot per owned runnable job - never first-match-by-stage, so two
 * derivatives sharing a stageId each dispatch under their own job id and
 * idempotency key. Inputs resolve per job through the same
 * resolveStageInput rules as the DAG (dependency outputs for motion-like
 * kinds, approved source otherwise); unresolvable inputs yield no slot and
 * are failed honestly by the exact fail pass below. Pure.
 */
export function selectExactSlots(
  stages: ProductionStagePlan[],
  ownedJobs: ProductionJob[],
  allJobs: ProductionJob[],
  sourceMediaUrl: string | undefined,
  activeCount: number,
  ceiling: number,
  now = Date.now()
): DispatchSlot[] {
  const slots: DispatchSlot[] = [];
  if (ceiling <= activeCount) return slots;
  const stageOutputs = seedStageOutputs(allJobs);
  for (const job of ownedJobs) {
    if (slots.length + activeCount >= ceiling) break;
    if (
      job.status !== "queued" &&
      !(job.status === "generating" && !job.outputUrl && !job.livepeerJobId)
    ) {
      continue;
    }
    const stage = stages.find((s) => s.id === job.stageId);
    if (!stage) continue;
    const resolved = resolveStageInput(stage, { sourceMediaUrl, stageOutputs });
    if (!resolved.url) continue;
    if (isBackoffPending(job, now)) continue;
    slots.push({
      job,
      inputUrl: resolved.url,
      resolvedInputSource: resolved.resolvedInputSource,
      ...(resolved.sourceStageId ? { sourceStageId: resolved.sourceStageId } : {})
    });
  }
  return slots;
}

/**
 * Find a resumable run: same idempotency key first, else an active run for
 * the same scope. Exact-job submits only match exact runs with the same job
 * set; stage submits only match stage-scoped runs with the same stage set -
 * a variation run never dedupes (or collides with) a pack run sharing its
 * stage, and vice versa.
 */
export function findActiveRun(
  runs: ProductionRun[] | undefined,
  idempotencyKey: string | undefined,
  stageIds: string[],
  jobIds?: string[]
): ProductionRun | undefined {
  const list = runs ?? [];
  if (idempotencyKey) {
    const byKey = list.find((r) => r.status === "active" && r.idempotencyKey === idempotencyKey);
    if (byKey) return byKey;
  }
  const exact = !!jobIds && jobIds.length > 0;
  if (exact) {
    const wanted = new Set(jobIds as string[]);
    return list.find(
      (r) => r.status === "active" && isExactRun(r) && (r.jobIds as string[]).length === wanted.size && (r.jobIds as string[]).every((j) => wanted.has(j))
    );
  }
  const wanted = new Set(stageIds);
  return list.find(
    (r) => r.status === "active" && !isExactRun(r) && r.stageIds.length === wanted.size && r.stageIds.every((s) => wanted.has(s))
  );
}

/**
 * Exact fail pass for exact-job runs: an owned job whose declared input
 * can never render fails alone with the reason - siblings and the original
 * stay untouched. Still-waiting dependencies stay queued for a later pass.
 * Extracted for the pump orchestrator; behavior identical to the inline
 * block it replaces.
 */
export async function failUnreadyExactJobs(input: {
  workspaceId: string;
  campaign: Campaign;
  run: ProductionRun;
  stages: ProductionStagePlan[];
  sourceMediaUrl: string | undefined;
}): Promise<void> {
  const { workspaceId, campaign, run, stages, sourceMediaUrl } = input;
  const terminalUnready = new Set(["failed", "cancelled", "storage_retry_needed"]);
  const stageOutputs = seedStageOutputs(campaign.jobs);
  for (const job of campaign.jobs.filter((j) => runOwnsJob(run, j))) {
    if (job.status !== "queued" && !(job.status === "generating" && !job.outputUrl && !job.livepeerJobId)) continue;
    const stage = stages.find((s) => s.id === job.stageId);
    if (!stage) continue;
    const resolved = resolveStageInput(stage, { sourceMediaUrl, stageOutputs });
    if (resolved.url) continue;
    const depId = resolved.sourceStageId ?? (stage.inputSource === "stage-output" ? stage.dependsOnStageIds[0] : undefined);
    if (depId) {
      const depJobs = campaign.jobs.filter((j) => j.stageId === depId);
      if (depJobs.length > 0 && !depJobs.some((j) => terminalUnready.has(j.status))) continue;
      const depStage = stages.find((s) => s.id === depId);
      await failStageJobs(
        campaign.id,
        stage.id,
        depStage ? prerequisiteMessage(stage, depStage) : (resolved.reason ?? "Declared input is not ready."),
        workspaceId,
        run.jobIds
      );
    } else {
      await failStageJobs(campaign.id, stage.id, resolved.reason ?? "Declared input is not ready.", workspaceId, run.jobIds);
    }
  }
}

/**
 * Build the preservation policy input for one dispatch slot (pure).
 * Ownership is verified against durable records, never trusted from the
 * slot: approved-source inputs must match the campaign's registered source
 * row byte-for-byte, stage outputs must belong to a job in this campaign,
 * and variation sources must be a completed output of this campaign (else
 * the variation request is dropped before the policy sees it).
 */
export function preservationContextFor(
  campaign: Campaign,
  sourceMedia: Array<{ id: string; url: string }>,
  stage: ProductionStagePlan,
  job: ProductionJob,
  slot: { inputUrl: string; resolvedInputSource: StageInputSource; sourceStageId?: string }
): {
  ctx: {
    stageId: string;
    kind: ProductionStagePlan["kind"];
    role: ProductionStagePlan["role"];
    sourceUrl?: string;
    sourceAssetId?: string;
    sourceStageId?: string;
    sourceOwnedByCampaign: boolean;
    rightsAllowed: boolean;
    variationExplicit: boolean;
    variationSourceUrl?: string;
    placeSubjectMode: "auto" | "off";
    fidelity?: StageFidelity;
  };
  sourceAssetId?: string;
} {
  const sourceRow = sourceMedia.find((m) => m.id === campaign.sourceMediaId);
  const owned = ownsDispatchSource(campaign, slot, sourceRow?.url);
  const approvedSource = slot.resolvedInputSource === "approved-source" && !!sourceRow && sourceRow.url === slot.inputUrl;
  const variationOwned =
    job.variationExplicit === true &&
    typeof job.variationSourceUrl === "string" &&
    campaign.jobs.some((j) => j.providerOutputUrl === job.variationSourceUrl || j.outputUrl === job.variationSourceUrl);
  return {
    ctx: {
      stageId: stage.id,
      kind: stage.kind,
      role: job.role ?? stage.role,
      sourceUrl: slot.inputUrl,
      ...(approvedSource ? { sourceAssetId: campaign.sourceMediaId } : {}),
      ...(slot.sourceStageId ? { sourceStageId: slot.sourceStageId } : {}),
      sourceOwnedByCampaign: owned,
      rightsAllowed: campaign.preflight?.decision === "allow",
      variationExplicit: job.variationExplicit === true,
      ...(variationOwned && job.variationSourceUrl ? { variationSourceUrl: job.variationSourceUrl } : {}),
      placeSubjectMode: placeSubjectMode(),
      ...(stage.fidelity && stage.fidelity !== "conceptual" ? { fidelity: stage.fidelity } : {})
    },
    ...(approvedSource ? { sourceAssetId: campaign.sourceMediaId } : {})
  };
}

/** Durable-record ownership check for the resolved dispatch input. */
function ownsDispatchSource(
  campaign: Campaign,
  slot: { inputUrl: string; resolvedInputSource: StageInputSource; sourceStageId?: string },
  sourceRowUrl?: string
): boolean {
  if (slot.resolvedInputSource === "stage-output") {
    if (!slot.sourceStageId) return false;
    return campaign.jobs.some(
      (j) => j.stageId === slot.sourceStageId && (j.providerOutputUrl === slot.inputUrl || j.outputUrl === slot.inputUrl)
    );
  }
  if (slot.resolvedInputSource === "approved-source") {
    // Initial production has no prior outputs: ownership is the registered
    // source row matching byte-for-byte, never a bare URL assertion.
    return !!sourceRowUrl && sourceRowUrl === slot.inputUrl;
  }
  // canonical-anchor: the URL must be a recorded output of this campaign.
  return campaign.jobs.some((j) => j.providerOutputUrl === slot.inputUrl || j.outputUrl === slot.inputUrl);
}
