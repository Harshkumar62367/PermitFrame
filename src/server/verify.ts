import { eq } from "drizzle-orm";
import { getDb } from "./db/client";
import { verificationSnapshots } from "./db/schema";
import type { PublicVerificationSnapshot } from "./types";

// Pure snapshot construction lives in ./verification-snapshot (no I/O, no
// session) so it stays unit-testable. Re-exported here for callers.
export { buildPublicSnapshot, newVerificationRef } from "./verification-snapshot";

export type VerificationLookup =
  | { found: true; snapshot: PublicVerificationSnapshot }
  | { found: false; ref: string };

/**
 * Anonymous verification read: queries ONLY the public snapshots table in
 * Neon. Never touches session workspace state, cookies, or auth - safe to
 * call from the public route without a Privy session.
 */
export async function lookupVerification(ref: string): Promise<VerificationLookup> {
  const rows = await getDb()
    .select({ payload: verificationSnapshots.payload })
    .from(verificationSnapshots)
    .where(eq(verificationSnapshots.ref, ref))
    .limit(1);
  const payload = rows[0]?.payload ?? null;
  if (!payload) return { found: false, ref };
  return { found: true, snapshot: payload };
}

/** Persist (upsert) the snapshot. Called at approval; content reflects latest approval. */
export async function saveVerificationSnapshot(snapshot: PublicVerificationSnapshot): Promise<void> {
  await getDb()
    .insert(verificationSnapshots)
    .values({ ref: snapshot.ref, campaignId: snapshot.campaignId, payload: snapshot, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: verificationSnapshots.ref,
      set: { campaignId: snapshot.campaignId, payload: snapshot, updatedAt: new Date() }
    });
}

export type VerificationResult = VerificationLookup;
