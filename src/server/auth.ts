import crypto from "node:crypto";
import "server-only";

import { PrivyClient } from "@privy-io/node";
import { and, eq, gt } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb } from "./db/client";
import { sessions, users, workspaceState, workspaces } from "./db/schema";
import type { Database } from "./types";

export const SESSION_COOKIE = "permitframe_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("Authentication required");
  }
}

function emptyDatabase(): Database {
  return {
    creators: [], passports: [], sourceMedia: [], productFacts: [], campaigns: [], consentInvites: [], events: []
  };
}

function privyClient(): PrivyClient {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) throw new Error("Privy server credentials are not configured.");
  return new PrivyClient({ appId, appSecret });
}

function tokenHash(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function safeProfile(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 160) || null : null;
}

export type WorkspaceSession = { userId: string; workspaceId: string; workspaceName: string };

export async function establishSession(input: { accessToken: string; email?: unknown; displayName?: unknown }) {
  const claims = await privyClient().utils().auth().verifyAccessToken(input.accessToken);
  const userId = claims.user_id;
  const email = safeProfile(input.email);
  const displayName = safeProfile(input.displayName) ?? email?.split("@")[0] ?? "My agency";
  const db = getDb();

  await db.insert(users).values({ id: userId, email, displayName, updatedAt: new Date() }).onConflictDoUpdate({
    target: users.id,
    set: { email, displayName, updatedAt: new Date() }
  });

  let [workspace] = await db.select().from(workspaces).where(eq(workspaces.ownerId, userId)).limit(1);
  if (!workspace) {
    const workspaceId = `ws_${crypto.randomBytes(12).toString("hex")}`;
    workspace = { id: workspaceId, ownerId: userId, name: `${displayName}'s workspace`, createdAt: new Date() };
    await db.insert(workspaces).values(workspace);
    await db.insert(workspaceState).values({ workspaceId, data: emptyDatabase(), updatedAt: new Date() });
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ tokenHash: tokenHash(token), userId, workspaceId: workspace.id, expiresAt });
  return { token, expiresAt, session: { userId, workspaceId: workspace.id, workspaceName: workspace.name } satisfies WorkspaceSession };
}

export async function revokeCurrentSession() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await getDb().delete(sessions).where(eq(sessions.tokenHash, tokenHash(token)));
}

export async function getCurrentSession(): Promise<WorkspaceSession | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const db = getDb();
  const [session] = await db
    .select({ userId: sessions.userId, workspaceId: sessions.workspaceId, workspaceName: workspaces.name })
    .from(sessions)
    .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
    .where(and(eq(sessions.tokenHash, tokenHash(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return session ?? null;
}

export async function requireCurrentSession(): Promise<WorkspaceSession> {
  const session = await getCurrentSession();
  if (!session) throw new AuthenticationRequiredError();
  return session;
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_MS / 1000
};
