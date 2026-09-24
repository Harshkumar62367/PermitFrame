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

/**
 * Append-only snapshot persistence. Every approval mints a fresh ref (see
 * approveCampaign/refreshVerificationSnapshot), so inserts never collide;
 * a repeated ref is a no-op that preserves history instead of overwriting
 * it. Old snapshots stay retrievable by their refs forever - persistence
 * never mutates a published row, so no immutability beyond append-only is
 * claimed or needed.
 */
export async function saveVerificationSnapshot(snapshot: PublicVerificationSnapshot): Promise<void> {
  await getDb()
    .insert(verificationSnapshots)
    .values({ ref: snapshot.ref, campaignId: snapshot.campaignId, payload: snapshot, updatedAt: new Date() })
    .onConflictDoNothing({ target: verificationSnapshots.ref });
}

export type VerificationResult = VerificationLookup;
