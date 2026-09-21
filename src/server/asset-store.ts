import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db/client";
import { campaignAssets } from "./db/schema";
import { isCloudinaryConfigured, uploadRemoteAsset, type StoredAsset } from "./cloudinary";
import { redactSecrets } from "./dkg/edge-node-adapter";
import type { ProductionJob } from "./types";

/** Max Cloudinary import attempts per job output (bounded retries). */
export const ASSET_MAX_ATTEMPTS = 3;

export type AssetOutcome =
  | { outcome: "stored"; asset: StoredAsset }
  | { outcome: "deferred"; reason: "unconfigured" }
  | { outcome: "failed"; error: string; attempts: number };

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "x";
}

/**
 * Deterministic, workspace-safe identity: ids only — never emails, wallets,
 * creator names, or prompt text. Same output always maps to one asset.
 */
export function assetIdentity(workspaceId: string, campaignId: string, jobId: string): { folder: string; publicId: string } {
  const folder = `permitframe/${sanitizeSegment(workspaceId)}/${sanitizeSegment(campaignId)}`;
  return { folder, publicId: `${sanitizeSegment(jobId)}` };
}

export function assetResourceType(kind: ProductionJob["kind"]): "image" | "video" {
  return kind === "image-to-video" ? "video" : "image";
}

function safeDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(raw).slice(0, 200);
}

/**
 * Persist one completed Livepeer output to Cloudinary. Idempotent: a stored
 * row short-circuits (no re-upload); attempts are bounded. Never throws —
 * failures return honestly for the caller to mark storage_pending.
 */
export async function persistJobAsset(input: {
  workspaceId: string;
  campaignId: string;
  job: Pick<ProductionJob, "id" | "kind" | "capability" | "outputUrl" | "providerOutputUrl"> & { livepeerJobId?: string; costUsd?: number };
  promptHash: string;
  providerModel?: string;
}): Promise<AssetOutcome> {
  const db = getDb();
  const providerUrl = input.job.providerOutputUrl ?? input.job.outputUrl;
  if (!providerUrl) return { outcome: "failed", error: "No provider output to persist.", attempts: 0 };
  const { folder, publicId } = assetIdentity(input.workspaceId, input.campaignId, input.job.id);

  const existing = await db.select().from(campaignAssets).where(eq(campaignAssets.jobId, input.job.id)).limit(1);
  const row = existing[0];
  if (row?.storageStatus === "stored" && row.storageUrl && row.storagePublicId) {
    return {
      outcome: "stored",
      asset: {
        publicId: row.storagePublicId,
        version: row.storageVersion ?? 0,
        secureUrl: row.storageUrl,
        resourceType: row.storageResourceType ?? "image",
        format: row.storageFormat ?? "",
        bytes: row.storageBytes ?? 0,
        width: row.storageWidth ?? undefined,
        height: row.storageHeight ?? undefined,
        duration: row.storageDuration ?? undefined
      }
    };
  }
  if ((row?.attempts ?? 0) >= ASSET_MAX_ATTEMPTS) {
    return { outcome: "failed", error: row?.storageError ?? "Storage retry budget exhausted.", attempts: row?.attempts ?? 0 };
  }
  if (!isCloudinaryConfigured()) return { outcome: "deferred", reason: "unconfigured" };

  const attempts = (row?.attempts ?? 0) + 1;
  if (!row) {
    await db.insert(campaignAssets).values({
      jobId: input.job.id,
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      storageStatus: "pending",
      attempts: 0,
      providerUrl,
      providerJobId: input.job.livepeerJobId ?? null,
      providerModel: input.providerModel ?? input.job.capability,
      providerCost: input.job.costUsd !== undefined ? String(input.job.costUsd) : null,
      promptHash: input.promptHash
    });
  } else {
    await db.update(campaignAssets).set({ attempts, updatedAt: new Date() }).where(eq(campaignAssets.jobId, input.job.id));
  }
  try {
    const asset = await uploadRemoteAsset({
      sourceUrl: providerUrl,
      folder,
      publicId,
      resourceType: assetResourceType(input.job.kind)
    });
    await db
      .update(campaignAssets)
      .set({
        storagePublicId: asset.publicId,
        storageVersion: asset.version,
        storageUrl: asset.secureUrl,
        storageResourceType: asset.resourceType,
        storageFormat: asset.format,
        storageBytes: asset.bytes,
        storageWidth: asset.width ?? null,
        storageHeight: asset.height ?? null,
        storageDuration: asset.duration ?? null,
        storageStatus: "stored",
        storageError: null,
        persistedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(campaignAssets.jobId, input.job.id));
    return { outcome: "stored", asset };
  } catch (error) {
    const diagnostic = safeDiagnostic(error);
    await db
      .update(campaignAssets)
      .set({ storageStatus: "failed", storageError: diagnostic, updatedAt: new Date() })
      .where(eq(campaignAssets.jobId, input.job.id));
    return { outcome: "failed", error: diagnostic, attempts };
  }
}

/** Retry pending/failed assets with remaining budget. Returns per-job results. */
export async function retryCampaignAssets(
  workspaceId: string,
  campaignId: string,
  loadJob: (jobId: string) => Promise<{ job: ProductionJob; promptHash: string } | null>
): Promise<{ retried: number; stored: number }> {
  const db = getDb();
  const rows = await db
    .select()
    .from(campaignAssets)
    .where(and(eq(campaignAssets.workspaceId, workspaceId), eq(campaignAssets.campaignId, campaignId)));
  let retried = 0;
  let stored = 0;
  for (const row of rows) {
    if (row.storageStatus === "stored" || row.attempts >= ASSET_MAX_ATTEMPTS) continue;
    const loaded = await loadJob(row.jobId);
    if (!loaded) continue;
    retried += 1;
    const outcome = await persistJobAsset({
      workspaceId,
      campaignId,
      job: { ...loaded.job, outputUrl: loaded.job.providerOutputUrl ?? loaded.job.outputUrl ?? row.providerUrl ?? undefined },
      promptHash: loaded.promptHash
    });
    if (outcome.outcome === "stored") stored += 1;
  }
  return { retried, stored };
}

export async function getCampaignAssets(workspaceId: string, campaignId: string) {
  return getDb()
    .select()
    .from(campaignAssets)
    .where(and(eq(campaignAssets.workspaceId, workspaceId), eq(campaignAssets.campaignId, campaignId)));
}

export async function getStorageHealth(): Promise<{ configured: boolean; reachable: boolean }> {
  const configured = isCloudinaryConfigured();
  if (!configured) return { configured, reachable: false };
  const { pingCloudinary } = await import("./cloudinary");
  return { configured, reachable: await pingCloudinary() };
}
