import type { Campaign, ProductionJob } from "../types";
import type { PreservationEvidenceLevel } from "@/lib/preservation";
import type { PreservationCapability } from "./preservation-policy";
import { sha256 } from "../store";
import { readWorkspace, writeWorkspace } from "./run-store";
import { LivepeerMcpClient, livepeerConfig } from "./mcp-client";
import { persistPreviewInBackground } from "./pipeline";
import { withCampaignLock } from "./mutex";
import { clearCapabilityQuarantine } from "./catalogue";
import { qualityCheckEnabled } from "./run-retry";
import { resolveSourceMediaUrl } from "../cloudinary";
import { isStrictFidelity } from "./preservation-policy";

/**
 * Blocking identity threshold for the fidelity gate. Stricter than the
 * 0.7 advisory review threshold: a strict-fidelity output must CLEAR this
 * bar, and an unusable check result (null score, transport failure) never
 * passes - unverified is not verified.
 */
export const FIDELITY_CRITIQUE_THRESHOLD = 0.8;

/**
 * Fidelity verdict from a critique_shot result. Pure: "passed" requires an
 * explicit passing score; null (unparseable) and failures fail closed.
 */
export function evaluateFidelityCheck(critique: { score: number | null; passed: boolean } | null): "passed" | "failed" {
  if (!critique || critique.score === null || !Number.isFinite(critique.score)) return "failed";
  return critique.score >= FIDELITY_CRITIQUE_THRESHOLD && critique.passed ? "passed" : "failed";
}

/**
 * Output finalization: preview recording, durable-storage kickoff, receipt
 * inputs, and advisory critique persistence. Depends on the tuning leaf
 * (kill-switch) and dependency-neutral modules only - never dispatch or
 * poll, so the finalize → dispatch/poll direction stays one-way.
 */

export interface DispatchInput {
  providerUrl?: string;
  livepeerJobId?: string;
  costUsd?: number;
  capability?: string;
  modelNote?: string;
}

/**
 * Preservation outcome recorded when a provider output lands: which tool
 * actually rendered it, what evidence level that earns, and whether the
 * operation succeeded. Finalize writes exactly this - success is observed
 * (a usable output URL), never assumed.
 */
export interface PreservationOutcome {
  actualCapability: PreservationCapability;
  evidenceLevel: PreservationEvidenceLevel;
  providerOperationSucceeded: boolean;
  fallbackReason?: string;
}

/**
 * Identity check for one strict-fidelity place_subject output. Compares the
 * generated output against the approved source across product shape,
 * silhouette, material, colour, and visible marks/logos (plus
 * facade/window/balcony geometry for properties, via the campaign's brand
 * context). Returns "failed" on any unusable result - including a critique
 * transport failure - so only a verified pass earns a preserved claim.
 * Provider verdict text is never persisted (fixed product-owned verdict).
 */
async function runFidelityCheck(input: {
  workspaceId: string;
  campaign: Campaign;
  generatedUrl: string;
}): Promise<"passed" | "failed"> {
  const db = await readWorkspace(input.workspaceId).catch(() => null);
  const sourceRow = db?.sourceMedia.find((m) => m.id === input.campaign.sourceMediaId);
  let sourceUrl: string | undefined;
  try {
    sourceUrl = sourceRow ? resolveSourceMediaUrl(sourceRow) : undefined;
  } catch {
    sourceUrl = undefined;
  }
  if (!sourceUrl) return "failed";
  try {
    const client = new LivepeerMcpClient(livepeerConfig());
    const critique = await client.critiqueShot({
      generatedUrl: input.generatedUrl,
      referenceUrl: sourceUrl,
      entityName: `${input.campaign.brand} ${input.campaign.productName}`.slice(0, 80),
      threshold: FIDELITY_CRITIQUE_THRESHOLD
    });
    return evaluateFidelityCheck(critique);
  } catch {
    return "failed";
  }
}

/** Record a provider output as preview, persist detached, critique advisory. */
export async function finalizeDispatchedJob(
  workspaceId: string,
  campaign: Campaign,
  job: ProductionJob,
  result: DispatchInput & { providerUrl: string; preservation?: PreservationOutcome }
): Promise<void> {
  await withCampaignLock(campaign.id, () =>
    writeWorkspace(workspaceId, (d) => {
      const j = d.campaigns.find((x) => x.id === campaign.id)?.jobs.find((x) => x.id === job.id);
      if (!j) return;
      // Structured actual capability: provider report wins, else the
      // dispatched value. job.capability stays the planned value - it is
      // never overwritten with display text.
      const actual = result.capability ?? j.actualCapability ?? j.capability;
      Object.assign(j, finalizedPreviewFields(result));
      j.actualCapability = actual;
      j.lastProviderJobId = result.livepeerJobId ?? j.lastProviderJobId ?? j.livepeerJobId;
      j.dispatchStartedAt = undefined;
      j.providerBudgetSeconds = undefined;
      j.dispatchBudgetSeconds = undefined;
      j.dispatchDeadlineAt = undefined;
      j.providerPhase = undefined;
      j.providerCancelAttemptedAt = undefined;
      j.providerCancelConfirmed = undefined;
      clearCapabilityQuarantine(actual);
      if (result.preservation) {
        j.requestMeta = {
          ...j.requestMeta,
          recoveryState: "none",
          preservationActualCapability: result.preservation.actualCapability,
          preservationEvidenceLevel: result.preservation.evidenceLevel,
          providerOperationSucceeded: result.preservation.providerOperationSucceeded,
          ...(result.preservation.fallbackReason ? { fallbackReason: result.preservation.fallbackReason } : {})
        };
        // A resolved preservation outcome retires its async handle: the
        // provider job delivered, so nothing remains pending.
        delete j.requestMeta.preservationPendingTool;
      }
    })
  );
  // Fidelity gate for strict stages rendered by place_subject. Runs BEFORE
  // the persist worker below builds the receipt, so a failed check lands
  // as a delivery block in the same write. Unlike the advisory check, this
  // gate can fail the output - and the critique dimensions named in the
  // record are product shape, silhouette, material, colour, visible
  // marks/logos (plus facade/window/balcony geometry for properties).
  const stageFidelity = campaign.preflight?.plan.find((s) => s.id === job.stageId)?.fidelity;
  if (
    isStrictFidelity(stageFidelity) &&
    result.preservation?.actualCapability === "place_subject" &&
    result.preservation.providerOperationSucceeded !== false &&
    result.providerUrl
  ) {
    const fidelityCheck = await runFidelityCheck({
      workspaceId,
      campaign,
      generatedUrl: result.providerUrl
    });
    await withCampaignLock(campaign.id, () =>
      writeWorkspace(workspaceId, (d) => {
        const j = d.campaigns.find((x) => x.id === campaign.id)?.jobs.find((x) => x.id === job.id);
        if (j) j.requestMeta = { ...j.requestMeta, fidelityCheck };
      })
    ).catch(() => undefined);
  }
  void persistPreviewInBackground({
    workspaceId,
    campaignId: campaign.id,
    jobId: job.id,
    providerUrl: result.providerUrl,
    promptHash: sha256(job.prompt),
    providerModel: result.capability ?? job.capability,
    livepeerJobId: result.livepeerJobId ?? job.livepeerJobId,
    costUsd: result.costUsd ?? job.costUsd,
    kind: job.kind
  }).catch(() => undefined);
  // Advisory vision check for image outputs (never fails the stage).
  if (qualityCheckEnabled() && job.kind !== "image-to-video") {
    const db = await readWorkspace(workspaceId).catch(() => null);
    // Advisory reference only: uploads resolve to a time-limited download
    // URL that is sent to the provider and never persisted (only the
    // resulting score/note are stored). This finalize step is its own
    // operation with its own single resolution - never a re-resolution of
    // a dispatch URL.
    const sourceRow = db?.sourceMedia.find((m) => m.id === campaign.sourceMediaId);
    let sourceUrl: string | undefined;
    try {
      sourceUrl = sourceRow ? resolveSourceMediaUrl(sourceRow) : undefined;
    } catch {
      sourceUrl = undefined;
    }
    if (sourceUrl) {
      try {
        const client = new LivepeerMcpClient(livepeerConfig());
        const critique = await client.critiqueShot({
          generatedUrl: result.providerUrl,
          referenceUrl: sourceUrl,
          entityName: `${campaign.brand} ${campaign.productName}`.slice(0, 80)
        });
        await withCampaignLock(campaign.id, () =>
          writeWorkspace(workspaceId, (d) => {
            const j = d.campaigns.find((x) => x.id === campaign.id)?.jobs.find((x) => x.id === job.id);
            if (j) {
              if (critique.score !== null) j.qualityScore = critique.score;
              j.qualityPassed = critique.passed;
              j.qualityNote = critique.note.slice(0, 300);
            }
          })
        ).catch(() => undefined);
      } catch {
        // Critique is advisory - its failure is recorded nowhere billable.
      }
    }
  }
}

/**
 * Field patch applied when a provider output lands (preview_ready).
 * Pure - finalizeDispatchedJob persists exactly this. Note: capability is
 * deliberately NOT patched - job.capability stays the planned value and
 * job.actualCapability tracks what rendered.
 */
export function finalizedPreviewFields(
  result: { providerUrl: string; livepeerJobId?: string; costUsd?: number; modelNote?: string }
): Partial<
  Pick<
    ProductionJob,
    "status" | "providerOutputUrl" | "outputUrl" | "providerUrlFingerprint" | "livepeerJobId" | "costUsd" | "modelNote"
  >
> {
  return {
    status: "preview_ready",
    providerOutputUrl: result.providerUrl,
    outputUrl: result.providerUrl,
    providerUrlFingerprint: sha256(result.providerUrl),
    ...(result.livepeerJobId ? { livepeerJobId: result.livepeerJobId } : {}),
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
    ...(result.modelNote ? { modelNote: result.modelNote.slice(0, 400) } : {})
  };
}
