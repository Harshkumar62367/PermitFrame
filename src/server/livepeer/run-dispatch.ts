import type {
  Campaign,
  ProductionJob,
  ProductionRun,
  ProductionStagePlan,
  StageInputSource
} from "../types";
import type { LivepeerMcpClient } from "./mcp-client";
import type { PreservationDecision } from "./preservation-policy";
import { nowIso } from "../store";
import { readWorkspace, writeWorkspace } from "./run-store";
import { assertCapabilityAvailable } from "./catalogue";
import { MODEL_OVERRIDE_UNAVAILABLE } from "./template-catalogue";
import { fetchLivePriceMap, quoteStage, stageSpendingCeiling } from "./pricing";
import { resolveMotionDuration } from "./duration-policy";
import { isUsableOutputUrl } from "./plan-dag";
import { failStageJobs } from "./pipeline";
import { withCampaignLock } from "./mutex";
import {
  classifyPreservationResult,
  preservationOperationKey,
  resolvePreservation,
  type PreservationCallOutcome
} from "./preservation-policy";
import { preservationContextFor, type DispatchSlot } from "./run-scope";
import { finalizeDispatchedJob } from "./run-finalize";
import {
  classifySubmitError,
  computeBackoffMs,
  maxDispatchAttempts,
  redactSubmitError
} from "./run-retry";

/**
 * Dispatch: one runnable slot becomes exactly one provider call - normal
 * create_media submits (with capability replacement and spend-cap gating),
 * preservation-policy invocation, and place_subject / create_variations
 * inline, async-track, and fallback handling. Depends on scope (context),
 * finalize (outcome recording), tuning (retry math), and leaf policy
 * modules - never poll or lifecycle, so dispatch → poll/lifecycle stays
 * one-way (poll imports the preservation-tool helpers from here).
 */

export type SubmitOutcome =
  | { action: "finalize"; providerUrl: string; costUsd?: number; capability?: string }
  | { action: "track"; jobId: string }
  | { action: "fail"; reason: string };

/**
 * Classify an async submit result. Inline usable outputs finalize
 * immediately (no provider id needed, none invented); a non-empty provider
 * id tracks for polling; neither fails honestly. Never an empty-string id.
 */
export function classifySubmitResult(result: {
  jobId?: string;
  outputUrl?: string;
  costUsd?: number;
  capability?: string;
}): SubmitOutcome {
  if (result.outputUrl && isUsableOutputUrl(result.outputUrl)) {
    return {
      action: "finalize",
      providerUrl: result.outputUrl,
      ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      ...(result.capability ? { capability: result.capability } : {})
    };
  }
  if (result.jobId && result.jobId.trim().length > 0) {
    return { action: "track", jobId: result.jobId };
  }
  return {
    action: "fail",
    reason: "Livepeer accepted the call but returned neither a usable output nor a provider job id - nothing was dispatched."
  };
}

/** Spend-cap gate before a dispatch. Unknown estimates never block. */
export function shouldDispatchUnderCap(
  spentUsd: number,
  stageEstimateUsd: number | null,
  capUsd: number | undefined
): { ok: boolean; reason?: string } {
  if (capUsd === undefined) return { ok: true };
  if (stageEstimateUsd === null) return { ok: true };
  if (spentUsd + stageEstimateUsd > capUsd) {
    return {
      ok: false,
      reason: `Dispatch refused: $${spentUsd.toFixed(2)} spent + $${stageEstimateUsd.toFixed(2)} estimated exceeds the $${capUsd.toFixed(2)} cap.`
    };
  }
  return { ok: true };
}

/**
 * Dispatch eligibility (pure): only unclaimed queued work, or a generating
 * row with no output and no provider id (a submit that never landed). Every
 * settled status - including ready_to_share with a delivery-blocked output -
 * is never re-dispatched. Both dispatchSlot and the claim path read this.
 */
export function isDispatchableJob(
  job: Pick<ProductionJob, "status" | "outputUrl" | "livepeerJobId">
): boolean {
  return job.status === "queued" || (job.status === "generating" && !job.outputUrl && !job.livepeerJobId);
}

function jobIdempotencyKey(campaignId: string, job: ProductionJob): string {
  return `pf_${campaignId}_${job.stageId}_${job.id}`;
}

/**
 * Exact input provenance written onto a job at dispatch: what the plan
 * declared, what actually fed the run, and which dependency supplied it.
 * Pure so the recovery test asserts the real mapping.
 */
export function provenanceMeta(
  stage: ProductionStagePlan,
  slot: { resolvedInputSource: StageInputSource; sourceStageId?: string },
  preservation?: PreservationDecision
): NonNullable<ProductionJob["requestMeta"]> {
  return {
    sourceKind: slot.sourceStageId ? "prior-output" : "source-media",
    inputSource: stage.inputSource,
    resolvedInputSource: slot.resolvedInputSource,
    ...(slot.sourceStageId ? { sourceStageId: slot.sourceStageId } : {}),
    qualityProfile: stage.qualityProfile,
    role: stage.role,
    ...(stage.fallbackFrom ? { fallbackFrom: stage.fallbackFrom } : {}),
    ...(preservation
      ? {
          preservationRequested: preservation.requested,
          preservationResolved: preservation.resolved,
          preservationEvidenceLevel: preservation.evidenceLevel,
          preservationRequestedCapability: preservation.requestedCapability,
          preservationActualCapability: preservation.actualCapability,
          ...(preservation.approvedSourceAssetId ? { approvedSourceAssetId: preservation.approvedSourceAssetId } : {}),
          ...(preservation.fallbackReason ? { fallbackReason: preservation.fallbackReason } : {})
        }
      : {})
  };
}

/** Record a failed preservation attempt durably before any fallback. */
async function recordPreservationFallback(
  workspaceId: string,
  campaignId: string,
  jobId: string,
  reason: string
): Promise<void> {
  await withCampaignLock(campaignId, () =>
    writeWorkspace(workspaceId, (d) => {
      const j = d.campaigns.find((x) => x.id === campaignId)?.jobs.find((x) => x.id === jobId);
      if (j) {
        j.requestMeta = {
          ...j.requestMeta,
          fallbackReason: reason.slice(0, 400),
          preservationActualCapability: "create_media",
          providerOperationSucceeded: false
        };
      }
    })
  );
}

/**
 * Persist an async preservation handle: the provider accepted the
 * preservation job and will deliver later. The PermitFrame job keeps its
 * generating status with the provider id, and the pending-tool marker
 * routes all later polling/finalization through the preservation outcome.
 * Returns after persisting - the pump polls on later passes; no
 * create_media fallback runs while the handle is pending.
 */
async function trackPreservationJob(
  workspaceId: string,
  campaignId: string,
  jobId: string,
  tool: "place_subject" | "create_variations",
  providerJobId: string
): Promise<void> {
  await withCampaignLock(campaignId, () =>
    writeWorkspace(workspaceId, (d) => {
      const j = d.campaigns.find((x) => x.id === campaignId)?.jobs.find((x) => x.id === jobId);
      if (j && j.status === "generating") {
        j.livepeerJobId = providerJobId;
        j.dispatchedAt = nowIso();
        j.requestMeta = { ...j.requestMeta, preservationPendingTool: tool };
      }
    })
  );
}

/**
 * Exhaust a preservation tool after its async handle died terminally with
 * no output: record the failure, re-queue the job for exactly one guided
 * render, and never retry the rejected tool for this job. Re-queueing
 * keeps the SAME job id (and the guided render reuses its stable key),
 * so no duplicate paid preservation job can follow.
 */
export async function failPreservationTool(
  workspaceId: string,
  campaignId: string,
  jobId: string,
  tool: "place_subject" | "create_variations",
  reason: string
): Promise<void> {
  await withCampaignLock(campaignId, () =>
    writeWorkspace(workspaceId, (d) => {
      const j = d.campaigns.find((x) => x.id === campaignId)?.jobs.find((x) => x.id === jobId);
      if (!j) return;
      const failed = new Set(j.requestMeta?.preservationFailedTools ?? []);
      failed.add(tool);
      j.requestMeta = {
        ...j.requestMeta,
        fallbackReason: reason.slice(0, 400),
        preservationActualCapability: "create_media",
        preservationFailedTools: [...failed],
        providerOperationSucceeded: false
      };
      delete j.requestMeta?.preservationPendingTool;
      // Back to the dispatch queue for the single guided fallback: the
      // provider handle is dead, so nothing is polled and nothing double-
      // spends. Attempts are untouched (this was one logical attempt).
      if (j.status === "generating" || j.status === "queued") {
        j.status = "queued";
        j.livepeerJobId = undefined;
        j.dispatchedAt = undefined;
      }
    })
  );
}

/**
 * Dispatch one runnable slot. Async submit persists the provider id
 * immediately; timeouts without an id retry later under the SAME
 * idempotency key (provider dedupes - no duplicate paid jobs).
 *
 * Exported for the pump orchestrator only; not part of the public runner
 * facade (route and test code never dispatch directly).
 */
export async function dispatchSlot(
  client: LivepeerMcpClient,
  workspaceId: string,
  campaign: Campaign,
  run: ProductionRun,
  slot: DispatchSlot,
  spentUsd: number
): Promise<boolean> {
  const db = await readWorkspace(workspaceId);
  const fresh = db.campaigns.find((c) => c.id === campaign.id);
  const stage = fresh?.preflight?.plan.find((s) => s.id === slot.job.stageId);
  const job = fresh?.jobs.find((j) => j.id === slot.job.id);
  if (!fresh || !stage || !job) return false;
  if (!isDispatchableJob(job)) {
    return false; // claimed by a concurrent pump - serialized writes decide
  }
  const isVideo = job.kind === "image-to-video";
  // Machine capability for pricing/dispatch/resolution: the structured
  // actual value, falling back to the planned one. Never display text.
  const dispatchCap = job.actualCapability ?? job.capability;
  // Final server-side re-resolution: policy may have shifted since submit.
  // Rejections fail the stage; adjustments dispatch resolved and persist it.
  const requestedSeconds = stage.requestedDurationSeconds ?? stage.durationSeconds ?? 5;
  let durationSeconds = stage.durationSeconds ?? (isVideo ? 5 : 0);
  if (isVideo) {
    const re = resolveMotionDuration(requestedSeconds, dispatchCap);
    if (!re.ok) {
      await failStageJobs(campaign.id, stage.id, `"${stage.label}": ${re.error}`, workspaceId, run.jobIds);
      return true;
    }
    durationSeconds = re.resolvedSeconds;
    // Persist unconditionally: seeded/manual rows may lack duration fields,
    // and uniformity keeps receipts truthful without special cases.
    await withCampaignLock(campaign.id, () =>
      writeWorkspace(workspaceId, (d) => {
        const c = d.campaigns.find((x) => x.id === campaign.id);
        const st = c?.preflight?.plan.find((s) => s.id === stage.id);
        if (st) {
          st.durationSeconds = re.resolvedSeconds;
          st.requestedDurationSeconds = re.requestedSeconds;
          if (re.adjustmentReason) st.durationNote = re.adjustmentReason;
          st.durationSource = re.source;
        }
        const j = c?.jobs.find((x) => x.id === job.id);
        if (j) {
          j.requestMeta = {
            ...j.requestMeta,
            durationSeconds: re.resolvedSeconds,
            requestedDurationSeconds: re.requestedSeconds,
            ...(re.adjustmentReason ? { durationNote: re.adjustmentReason } : {}),
            durationSource: re.source
          };
        }
      })
    );
  }
  const live = await fetchLivePriceMap();
  const quote = quoteStage({ capability: dispatchCap, kind: job.kind }, live, durationSeconds);
  const capGate = shouldDispatchUnderCap(spentUsd, quote ? quote.usd : null, run.spendCapUsd ?? campaign.request.productionSpec?.maxSpendCapUsd);
  if (!capGate.ok) {
    await failStageJobs(campaign.id, stage.id, capGate.reason ?? "Spend cap reached.", workspaceId, run.jobIds);
    return true;
  }
  try {
    await assertCapabilityAvailable(dispatchCap);
  } catch (error) {
    // A user-pinned model is never substituted: the guard failure carries
    // the static safe message (zero create_media calls happen above or
    // below this point). Automatic stages keep the detailed provider error.
    const pinned = stage.requestedCapability;
    const message =
      pinned !== undefined && dispatchCap === pinned ? MODEL_OVERRIDE_UNAVAILABLE : (error as Error).message;
    await failStageJobs(campaign.id, stage.id, message, workspaceId, run.jobIds);
    return true;
  }

  // Preservation policy: strongest honest path for this stage, validated
  // before any paid dispatch. Refusals fail the stage with the reason and
  // spend nothing - no silent fallback to an arbitrary render.
  const { ctx: preservationCtx } = preservationContextFor(fresh, db.sourceMedia, stage, job, slot);
  const preservation = resolvePreservation(preservationCtx);
  if (preservation.refusal) {
    await failStageJobs(campaign.id, stage.id, `"${stage.label}": ${preservation.refusal}`, workspaceId, run.jobIds);
    return true;
  }

  const base = {
    capability: dispatchCap,
    kind: job.kind,
    prompt: job.prompt,
    sourceUrl: slot.inputUrl,
    maxCostUsd: stageSpendingCeiling({ capability: dispatchCap, kind: job.kind }, live, durationSeconds),
    inputs: { aspect_ratio: stage.format, ...(isVideo ? { duration: durationSeconds } : {}) },
    qualityProfile: stage.qualityProfile,
    sessionId: campaign.id,
    idempotencyKey: jobIdempotencyKey(campaign.id, job)
  };

  // Mark generating + provenance first (compare-and-set inside the lock -
  // a concurrent pump that already claimed this job loses harmlessly).
  let claimed = false;
  await withCampaignLock(campaign.id, () =>
    writeWorkspace(workspaceId, (d) => {
      const c = d.campaigns.find((x) => x.id === campaign.id);
      const j = c?.jobs.find((x) => x.id === job.id);
      if (!c || !j) return;
      if (!isDispatchableJob(j)) return;
      c.status = "generating";
      j.status = "generating";
      j.startedAt = nowIso();
      j.runId = run.id;
      j.attempts = (j.attempts ?? 0) + 1;
      j.lastAttemptAt = nowIso();
      // A fresh attempt clears any prior backoff; failures re-arm it below.
      j.nextAttemptAt = undefined;
      j.lastTransientError = undefined;
      j.requestMeta = {
        ...j.requestMeta,
        ...provenanceMeta(
          stage,
          {
            resolvedInputSource: slot.resolvedInputSource,
            ...(slot.sourceStageId ? { sourceStageId: slot.sourceStageId } : {})
          },
          preservation
        )
      };
      if (!j.requestedCapability) j.requestedCapability = stage.capability;
      if (!j.qualityProfile) j.qualityProfile = stage.qualityProfile;
      if (!j.role) j.role = stage.role;
      // Structured actual capability: what this dispatch sends. The planned
      // value in j.capability is never overwritten with display text.
      j.actualCapability = j.capability;
      claimed = true;
    })
  );
  if (!claimed) return false;

  // place_subject only when the policy resolved subject-placement for an
  // eligible image stage with a verified source - and never after the tool
  // failed terminally for this job (exhausted tools stay exhausted: a
  // rejected preservation op must not become a second paid provider job).
  // The response classifies three ways: inline output finalizes; a valid
  // async handle is persisted and polled (no fallback while pending); only
  // a malformed/handle-less response falls back to guided create_media.
  if (
    preservation.resolved === "subject-placement" &&
    !(job.requestMeta?.preservationFailedTools ?? []).includes("place_subject")
  ) {
    // Stale marker with no provider id (e.g. reset cleared the handle):
    // drop it so this attempt is judged on its own response.
    if (job.requestMeta?.preservationPendingTool && !job.livepeerJobId) {
      const stale = job.requestMeta.preservationPendingTool;
      await withCampaignLock(campaign.id, () =>
        writeWorkspace(workspaceId, (d) => {
          const j = d.campaigns.find((x) => x.id === campaign.id)?.jobs.find((x) => x.id === job.id);
          if (j?.requestMeta?.preservationPendingTool === stale && !j.livepeerJobId) {
            delete j.requestMeta.preservationPendingTool;
          }
        })
      );
    }
    let placeOutcome: PreservationCallOutcome;
    let placeCostUsd: number | undefined;
    let placeCapability: string | undefined;
    try {
      const placed = await client.placeSubject({
        sourceUrl: slot.inputUrl,
        scenes: [job.prompt],
        maxCostUsd: base.maxCostUsd,
        sessionId: campaign.id,
        idempotencyKey: preservationOperationKey(jobIdempotencyKey(campaign.id, job), "place")
      });
      placeOutcome = classifyPreservationResult(placed?.outputUrls, placed?.jobId);
      placeCostUsd = placed?.costUsd;
      placeCapability = placed?.capability;
    } catch (error) {
      placeOutcome = { kind: "empty", reason: `place_subject call failed: ${(error as Error).message.slice(0, 200)}` };
    }
    if (placeOutcome.kind === "inline") {
      await finalizeDispatchedJob(workspaceId, campaign, job, {
        providerUrl: placeOutcome.url,
        ...(placeCostUsd !== undefined ? { costUsd: placeCostUsd } : {}),
        ...(placeCapability ? { capability: placeCapability } : {}),
        modelNote: "place_subject operation succeeded",
        preservation: {
          actualCapability: "place_subject",
          evidenceLevel: "subject-preserving",
          providerOperationSucceeded: true
        }
      });
      return true;
    }
    if (placeOutcome.kind === "track") {
      // Async handle: persist the provider id on this job and stop. The
      // poll path owns it from here; create_media must not run while the
      // preservation job is pending (selectors skip generating jobs that
      // hold a provider id).
      await trackPreservationJob(workspaceId, campaign.id, job.id, "place_subject", placeOutcome.jobId);
      return true;
    }
    await recordPreservationFallback(
      workspaceId,
      campaign.id,
      job.id,
      `Subject placement failed (${placeOutcome.reason}) - falling back to guided generation.`
    );
    if (!preservation.allowFallbackToSourceGuided) {
      await failStageJobs(campaign.id, stage.id, `"${stage.label}": subject placement failed and fallback is not permitted (${placeOutcome.reason}).`, workspaceId, run.jobIds);
      return true;
    }
  }

  // create_variations only for explicit refinements carrying a selected
  // completed output (revise / variations actions). Initial production jobs
  // never set variationExplicit, so automatic variation is impossible here
  // even if a stale variationSourceUrl lingers on the record. Like
  // place_subject above: inline finalizes, async handles track-and-poll,
  // and only handle-less responses fall back to guided generation.
  let variationFallbackReason: string | undefined;
  if (
    preservation.resolved === "variation" &&
    !(job.requestMeta?.preservationFailedTools ?? []).includes("create_variations")
  ) {
    if (job.requestMeta?.preservationPendingTool && !job.livepeerJobId) {
      const stale = job.requestMeta.preservationPendingTool;
      await withCampaignLock(campaign.id, () =>
        writeWorkspace(workspaceId, (d) => {
          const j = d.campaigns.find((x) => x.id === campaign.id)?.jobs.find((x) => x.id === job.id);
          if (j?.requestMeta?.preservationPendingTool === stale && !j.livepeerJobId) {
            delete j.requestMeta.preservationPendingTool;
          }
        })
      );
    }
    let varyOutcome: PreservationCallOutcome;
    let variedCostUsd: number | undefined;
    let variedCapability: string | undefined;
    try {
      const varied = await client.createVariations({
        sourceUrl: job.variationSourceUrl as string,
        prompt: job.prompt,
        mode: "prompt",
        count: 1,
        maxCostUsd: base.maxCostUsd,
        sessionId: campaign.id,
        idempotencyKey: preservationOperationKey(jobIdempotencyKey(campaign.id, job), "vary")
      });
      varyOutcome = classifyPreservationResult(varied?.outputUrls, varied?.jobId);
      variedCostUsd = varied?.costUsd;
      variedCapability = varied?.capability;
    } catch (error) {
      varyOutcome = { kind: "empty", reason: `create_variations call failed (${(error as Error).message.slice(0, 200)})` };
    }
    if (varyOutcome.kind === "inline") {
      await finalizeDispatchedJob(workspaceId, campaign, job, {
        providerUrl: varyOutcome.url,
        ...(variedCostUsd !== undefined ? { costUsd: variedCostUsd } : {}),
        ...(variedCapability ? { capability: variedCapability } : {}),
        modelNote: "create_variations (explicit refinement)",
        preservation: {
          actualCapability: "create_variations",
          // A variation derives from a selected output, not the approved
          // source: provenance, never a preservation claim.
          evidenceLevel: "none",
          providerOperationSucceeded: true
        }
      });
      return true;
    }
    if (varyOutcome.kind === "track") {
      await trackPreservationJob(workspaceId, campaign.id, job.id, "create_variations", varyOutcome.jobId);
      return true;
    }
    variationFallbackReason = `${varyOutcome.reason} - rendered as a guided output instead.`;
    await recordPreservationFallback(workspaceId, campaign.id, job.id, variationFallbackReason);
    if (!preservation.allowFallbackToSourceGuided) {
      await failStageJobs(campaign.id, stage.id, `"${stage.label}": ${variationFallbackReason}`, workspaceId, run.jobIds);
      return true;
    }
  }

  // Standard path: async submit (id persisted immediately), poll later.
  // Timeouts without an id retry under the SAME key - provider dedupes.
  // Transient failures arm a persisted backoff (resumable, no busy loop);
  // terminal rejections and exhausted attempts fail only this stage.
  let submitted;
  try {
    submitted = await client.submitMedia(base);
  } catch (error) {
    const replacement = (error as Error).message.match(/recommended replacement is ([a-z0-9-]+)/i);
    if (!replacement) {
      await recordDispatchFailure(workspaceId, campaign, job, stage, error);
      return true;
    }
    // The replacement model gets its own duration resolution + pricing:
    // different buckets or limits may apply. Rejections fail honestly;
    // the retry keeps the requested length, never the old numbers.
    const replacementCap = replacement[1];
    let replacementInput = { ...base, capability: replacementCap };
    if (isVideo) {
      const re = resolveMotionDuration(requestedSeconds, replacementCap);
      if (!re.ok) {
        await failStageJobs(
          campaign.id,
          stage.id,
          `"${stage.label}": replacement model ${replacementCap} rejected the length - ${re.error}`,
          workspaceId,
          run.jobIds
        );
        return true;
      }
      const reQuote = quoteStage({ capability: replacementCap, kind: job.kind }, live, re.resolvedSeconds);
      const reCeiling = stageSpendingCeiling({ capability: replacementCap, kind: job.kind }, live, re.resolvedSeconds);
      // The replacement may price differently - re-check the run cap before spending.
      const reCapGate = shouldDispatchUnderCap(
        spentUsd,
        reQuote ? reQuote.usd : null,
        run.spendCapUsd ?? campaign.request.productionSpec?.maxSpendCapUsd
      );
      if (!reCapGate.ok) {
        await failStageJobs(campaign.id, stage.id, reCapGate.reason ?? "Spend cap reached.", workspaceId, run.jobIds);
        return true;
      }
      replacementInput = {
        ...replacementInput,
        maxCostUsd: reCeiling,
        inputs: { aspect_ratio: stage.format, duration: re.resolvedSeconds }
      };
      await withCampaignLock(campaign.id, () =>
        writeWorkspace(workspaceId, (d) => {
          const c = d.campaigns.find((x) => x.id === campaign.id);
          const st = c?.preflight?.plan.find((s) => s.id === stage.id);
          if (st) {
            st.durationSeconds = re.resolvedSeconds;
            st.requestedDurationSeconds = re.requestedSeconds;
            if (re.adjustmentReason) st.durationNote = re.adjustmentReason;
            st.durationSource = re.source;
          }
          const j = c?.jobs.find((x) => x.id === job.id);
          if (j?.requestMeta) {
            j.requestMeta.durationSeconds = re.resolvedSeconds;
            j.requestMeta.requestedDurationSeconds = re.requestedSeconds;
            if (re.adjustmentReason) j.requestMeta.durationNote = re.adjustmentReason;
            j.requestMeta.durationSource = re.source;
          }
        })
      );
    }
    try {
      submitted = await client.submitMedia(replacementInput);
    } catch (second) {
      await recordDispatchFailure(workspaceId, campaign, job, stage, second);
      return true;
    }
    await withCampaignLock(campaign.id, () =>
      writeWorkspace(workspaceId, (d) => {
        const j = d.campaigns.find((x) => x.id === campaign.id)?.jobs.find((x) => x.id === job.id);
        // Structured substitution: planned capability untouched, actual
        // tracks the replacement. UI derives its friendly label from these
        // fields - never from formatted text.
        if (j) j.actualCapability = replacementCap;
      })
    );
  }
  const outcome = classifySubmitResult(submitted);
  if (outcome.action === "finalize") {
    // Standard create_media render: source-guided when the policy resolved
    // guided generation (or fell back to it); otherwise no preservation
    // claim beyond the recorded fallback reason.
    const guided = preservation.resolved === "source-guided-generation";
    await finalizeDispatchedJob(workspaceId, campaign, job, {
      providerUrl: outcome.providerUrl,
      costUsd: outcome.costUsd,
      capability: outcome.capability,
      preservation: {
        actualCapability: "create_media",
        evidenceLevel: guided ? "source-guided" : "none",
        providerOperationSucceeded: true,
        ...(preservation.fallbackReason || variationFallbackReason
          ? { fallbackReason: [preservation.fallbackReason, variationFallbackReason].filter(Boolean).join(" ") }
          : {})
      }
    });
    return true;
  }
  if (outcome.action === "fail") {
    await failStageJobs(campaign.id, stage.id, outcome.reason, workspaceId, run.jobIds);
    return true;
  }
  await withCampaignLock(campaign.id, () =>
    writeWorkspace(workspaceId, (d) => {
      const j = d.campaigns.find((x) => x.id === campaign.id)?.jobs.find((x) => x.id === job.id);
      if (j && j.status === "generating" && outcome.action === "track") {
        j.livepeerJobId = outcome.jobId;
        j.dispatchedAt = nowIso();
      }
    })
  );
  return true;
}

/**
 * Record a submit failure durably: terminal rejections and exhausted
 * attempts fail the stage with the honest provider reason (siblings
 * continue); transient failures keep the job resumable with exponential
 * backoff and a redacted note. Same idempotency key on every retry.
 */
async function recordDispatchFailure(
  workspaceId: string,
  campaign: Campaign,
  job: ProductionJob,
  stage: { id: string },
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : "Submit failed.";
  const kind = classifySubmitError(message);
  const now = nowIso();
  let exhausted = false;
  await withCampaignLock(campaign.id, () =>
    writeWorkspace(workspaceId, (d) => {
      const j = d.campaigns.find((x) => x.id === campaign.id)?.jobs.find((x) => x.id === job.id);
      if (!j || (j.status !== "generating" && j.status !== "queued")) return;
      const attempts = j.attempts ?? 1;
      j.lastAttemptAt = now;
      j.lastTransientError = redactSubmitError(message);
      if (kind === "terminal" || attempts >= maxDispatchAttempts()) {
        exhausted = true;
        return;
      }
      j.nextAttemptAt = new Date(Date.now() + computeBackoffMs(attempts)).toISOString();
    })
  );
  if (!exhausted) return;
  const reason =
    kind === "terminal"
      ? `Livepeer refused this stage: ${redactSubmitError(message)}`
      : `Livepeer submit failed ${maxDispatchAttempts()} times: ${redactSubmitError(message)}`;
  await withCampaignLock(campaign.id, () =>
    writeWorkspace(workspaceId, (d) => {
      const c = d.campaigns.find((x) => x.id === campaign.id);
      const j = c?.jobs.find((x) => x.id === job.id);
      if (c) c.status = "review";
      if (j && (j.status === "generating" || j.status === "queued")) {
        j.status = "failed";
        j.error = reason.slice(0, 400);
        j.finishedAt = nowIso();
      }
    })
  );
}
