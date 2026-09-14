import crypto from "node:crypto";
import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "./db/client";
import { applicationState, workspaceState } from "./db/schema";
import { requireCurrentSession } from "./auth";
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
    events: []
  };
}

export async function loadDb(): Promise<Database> {
  const session = await requireCurrentSession();
  const db = getDb();
  const [row] = await db
    .select({ data: workspaceState.data })
    .from(workspaceState)
    .where(eq(workspaceState.workspaceId, session.workspaceId))
    .limit(1);

  if (row) return row.data;

  const data = emptyDb();
  await db.insert(workspaceState).values({ workspaceId: session.workspaceId, data }).onConflictDoNothing();
  return data;
}

export async function updateDb(mutator: (db: Database) => void): Promise<Database> {
  const session = await requireCurrentSession();
  const db = await loadDb();
  mutator(db);
  await getDb()
    .insert(workspaceState)
    .values({ workspaceId: session.workspaceId, data: db, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: workspaceState.workspaceId,
      set: { data: db, updatedAt: new Date() }
    });
  return db;
}

/** The original seeded state remains publicly readable for proof and demo links. */
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
