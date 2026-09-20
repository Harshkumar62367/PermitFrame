import "server-only";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { getDb } from "./db/client";
import { campaigns, passports, productFactsRows, sourceMediaRows, workspaceEvents } from "./db/schema";
import type { AuditEvent, Campaign, Database } from "./types";

/** First campaign-shaped ref wins; events without one are workspace-scoped. */
function campaignIdFromRefs(refs: string[]): string | null {
  return refs.find((r) => r.startsWith("cmp_")) ?? null;
}

function normalizeCampaign(c: Campaign): Campaign {
  return { ...c, comments: c.comments ?? [], captions: c.captions ?? [] };
}

/**
 * Mirror the workspace blob's hot collections into normalized tables.
 * Best-effort: never throws, so a mirror failure can never break the
 * blob write it follows (the blob stays the fallback source of truth).
 */
export async function mirrorWorkspaceToNormalized(workspaceId: string, data: Database): Promise<void> {
  try {
    const db = getDb();
    for (const c of data.campaigns) {
      await db
        .insert(campaigns)
        .values({
          id: c.id,
          workspaceId,
          status: c.status,
          title: c.title,
          updatedAt: c.updatedAt ? new Date(c.updatedAt) : new Date(),
          data: normalizeCampaign(c)
        })
        .onConflictDoUpdate({
          target: campaigns.id,
          set: {
            workspaceId,
            status: c.status,
            title: c.title,
            updatedAt: c.updatedAt ? new Date(c.updatedAt) : new Date(),
            data: normalizeCampaign(c)
          }
        });
    }
    // Deletes propagate: a campaign removed from the blob must not survive
    // in the normalized table (otherwise deleted detail URLs resurrect).
    // Events intentionally survive (audit history stays by design).
    const liveIds = new Set(data.campaigns.map((c) => c.id));
    const existing = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(eq(campaigns.workspaceId, workspaceId));
    const stale = existing.map((r) => r.id).filter((id) => !liveIds.has(id));
    if (stale.length > 0) {
      if (liveIds.size === 0) {
        await db.delete(campaigns).where(eq(campaigns.workspaceId, workspaceId));
      } else {
        await db.delete(campaigns).where(and(eq(campaigns.workspaceId, workspaceId), notInArray(campaigns.id, [...liveIds])));
      }
    }
    for (const e of data.events) {
      await db
        .insert(workspaceEvents)
        .values({
          id: e.id,
          workspaceId,
          campaignId: campaignIdFromRefs(e.refs),
          kind: e.kind,
          at: e.at ? new Date(e.at) : new Date(),
          summary: e.summary,
          refs: e.refs,
          data: e
        })
        .onConflictDoNothing({ target: workspaceEvents.id });
    }
    for (const p of data.passports) {
      await db
        .insert(passports)
        .values({ id: p.id, workspaceId, data: p, updatedAt: new Date() })
        .onConflictDoUpdate({ target: passports.id, set: { workspaceId, data: p, updatedAt: new Date() } });
    }
    for (const m of data.sourceMedia) {
      await db
        .insert(sourceMediaRows)
        .values({ id: m.id, workspaceId, data: m, updatedAt: new Date() })
        .onConflictDoUpdate({ target: sourceMediaRows.id, set: { workspaceId, data: m, updatedAt: new Date() } });
    }
    for (const f of data.productFacts) {
      await db
        .insert(productFactsRows)
        .values({ id: f.id, workspaceId, data: f, updatedAt: new Date() })
        .onConflictDoUpdate({ target: productFactsRows.id, set: { workspaceId, data: f, updatedAt: new Date() } });
    }
  } catch (error) {
    console.warn("[campaign-store] mirror failed (blob remains canonical):", error instanceof Error ? error.message : error);
  }
}

export interface CampaignDetailNormalized {
  campaign: Campaign;
  sourceMedia: Database["sourceMedia"][number] | null;
  passport: Database["passports"][number] | null;
  productFacts: Database["productFacts"][number] | null;
}

/**
 * Single-workspace indexed reads: 1 campaign row + 3 single-row lookups.
 * Returns null when the campaign has no normalized row yet (caller falls
 * back to the blob), so pre-backfill workspaces keep working.
 */
export async function loadCampaignDetailNormalized(
  workspaceId: string,
  campaignId: string
): Promise<CampaignDetailNormalized | null> {
  const db = getDb();
  const [row] = await db.select().from(campaigns).where(and(eq(campaigns.workspaceId, workspaceId), eq(campaigns.id, campaignId))).limit(1);
  if (!row) return null;
  const campaign = normalizeCampaign(row.data);
  const [[mediaRow], [passportRow], [factsRow]] = await Promise.all([
    db.select().from(sourceMediaRows).where(eq(sourceMediaRows.id, campaign.sourceMediaId)).limit(1),
    db.select().from(passports).where(eq(passports.id, campaign.passportId)).limit(1),
    db.select().from(productFactsRows).where(eq(productFactsRows.id, campaign.productFactsId)).limit(1)
  ]);
  return {
    campaign,
    sourceMedia: mediaRow?.data ?? null,
    passport: passportRow?.data ?? null,
    productFacts: factsRow?.data ?? null
  };
}

/** Newest-first events for one campaign, LIMIT-bound (no whole-blob scan). */
export async function loadCampaignEventsNormalized(
  workspaceId: string,
  campaignId: string,
  limit = 50
): Promise<AuditEvent[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(workspaceEvents)
    .where(and(eq(workspaceEvents.workspaceId, workspaceId), eq(workspaceEvents.campaignId, campaignId)))
    .orderBy(desc(workspaceEvents.at))
    .limit(limit);
  return rows.map((r) => r.data);
}

/** Newest-first workspace activity, LIMIT-bound for overview/snapshot feeds. */
export async function loadRecentEventsNormalized(workspaceId: string, limit = 12): Promise<AuditEvent[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(workspaceEvents)
    .where(eq(workspaceEvents.workspaceId, workspaceId))
    .orderBy(desc(workspaceEvents.at))
    .limit(limit);
  return rows.map((r) => r.data);
}
