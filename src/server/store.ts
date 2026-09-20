import crypto from "node:crypto";
import "server-only";
import { and, eq, gt } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb } from "./db/client";
import { applicationState, sessions, workspaceState } from "./db/schema";
import { AuthenticationRequiredError, requireCurrentSession, SESSION_COOKIE } from "./auth";
import type { Database } from "./types";

const PRIMARY_STATE_ID = "primary";

export function emptyDb(): Database {
  return {
    creators: [],
    passports: [],
    sourceMedia: [],
    productFacts: [],
    campaigns: [],
    consentInvites: [],
    events: [],
    idempotencyKeys: {},
    deletedCampaigns: []
  };
}

export async function loadDb(): Promise<Database> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) throw new AuthenticationRequiredError();
  const db = getDb();
  const [row] = await db
    .select({ data: workspaceState.data })
    .from(sessions)
    .innerJoin(workspaceState, eq(workspaceState.workspaceId, sessions.workspaceId))
    .where(and(eq(sessions.tokenHash, crypto.createHash("sha256").update(token).digest("hex")), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (row) return row.data;
  throw new AuthenticationRequiredError();
}

export async function updateDb(mutator: (db: Database) => void): Promise<Database> {
  const session = await requireCurrentSession();
  return updateWorkspaceDb(session.workspaceId, mutator);
}

/** Write to an explicitly resolved workspace (no viewer session required). */
export async function updateWorkspaceDb(
  workspaceId: string,
  mutator: (db: Database) => void
): Promise<Database> {
  const db = getDb();
  const [row] = await db
    .select({ data: workspaceState.data })
    .from(workspaceState)
    .where(eq(workspaceState.workspaceId, workspaceId))
    .limit(1);
  const data = row?.data ?? emptyDb();
  mutator(data);
  await db
    .insert(workspaceState)
    .values({ workspaceId, data, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: workspaceState.workspaceId,
      set: { data, updatedAt: new Date() }
    });
  // Mirror hot collections to normalized tables (best-effort, never throws).
  // The blob above stays canonical until backfill is verified.
  const { mirrorWorkspaceToNormalized } = await import("./campaign-store");
  await mirrorWorkspaceToNormalized(workspaceId, data);
  return data;
}

/**
 * Resolve the workspace that owns a creator consent invite, without
 * requiring the *viewer's* session. The unguessable invite token is the
 * capability: external creators attest from a bare link with no agency
 * account. Returns null when no workspace holds the token.
 */
export async function loadInviteContext(
  token: string
): Promise<{ workspaceId: string; db: Database } | null> {
  const db = getDb();
  const rows = await db
    .select({ workspaceId: workspaceState.workspaceId, data: workspaceState.data })
    .from(workspaceState);
  for (const row of rows) {
    if (row.data.consentInvites.some((i) => i.token === token)) {
      return { workspaceId: row.workspaceId, db: row.data };
    }
  }
  return null;
}

/** Public verification reads use the application-level state only when applicable. */
export async function loadPublicDb(): Promise<Database> {
  const db = getDb();
  const [row] = await db
    .select({ data: applicationState.data })
    .from(applicationState)
    .where(eq(applicationState.id, PRIMARY_STATE_ID))
    .limit(1);
  return row?.data ?? emptyDb();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}
