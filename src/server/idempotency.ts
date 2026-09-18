import crypto from "node:crypto";
import type { Database, IdempotencyRecord } from "./types";

/**
 * Campaign-creation idempotency. Pure slot operations over a Database object
 * (no session, no I/O) so the semantics are unit-testable; the route wraps
 * them in loadDb/updateDb, which is the durable store. A separate in-process
 * single-flight lock serializes concurrent same-key requests within one
 * server instance (double-clicks, double tabs).
 */

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Same key reused with a different payload — a client bug, never a second campaign. */
export class IdempotencyMismatchError extends Error {
  constructor() {
    super("This submission key was already used with different campaign details. Start a fresh submission to create a new campaign.");
    this.name = "IdempotencyMismatchError";
  }
}

export interface CreationIntent {
  title: string;
  brand: string;
  productName: string;
  creatorId: string;
  sourceMediaId: string;
  passportId: string;
  productFactsId: string;
  platform: string;
  country: string;
  requestedClaims: string[];
  transformation: string;
  creativeBrief: string;
}

/** Stable fingerprint of the normalized intent — key reuse with different intent is a client bug. */
export function fingerprintCreationIntent(intent: CreationIntent): string {
  const canonical = JSON.stringify({
    title: intent.title.trim(),
    brand: intent.brand,
    productName: intent.productName,
    creatorId: intent.creatorId,
    sourceMediaId: intent.sourceMediaId,
    passportId: intent.passportId,
    productFactsId: intent.productFactsId,
    platform: intent.platform.toLowerCase(),
    country: intent.country.toUpperCase(),
    requestedClaims: [...intent.requestedClaims].map((c) => c.trim().toLowerCase()).sort(),
    transformation: intent.transformation.toLowerCase(),
    creativeBrief: intent.creativeBrief.trim()
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function slots(db: Database): Record<string, IdempotencyRecord> {
  // Legacy workspace rows predate the map — treat as empty, never crash.
  if (!db.idempotencyKeys) db.idempotencyKeys = {};
  return db.idempotencyKeys;
}

export function readIdempotencySlot(db: Database, key: string): IdempotencyRecord | undefined {
  return slots(db)[key];
}

export type ReserveOutcome =
  | { outcome: "reserved" }
  | { outcome: "replay"; campaignId: string }
  | { outcome: "mismatch"; expected: string; received: string }
  | { outcome: "takeover" };

/**
 * Inspect-and-reserve in one mutator pass. Callers persist `db` afterwards
 * (updateDb) so the reservation survives a crash between reserve and create.
 * - completed + fingerprint match → replay the original campaign id.
 * - completed + fingerprint mismatch → client error, never a second campaign.
 * - processing/failed (no live holder — the in-process lock guarantees that)
 *   → take over and run creation again.
 */
export function reserveIdempotencySlot(db: Database, key: string, fingerprint: string, now: string): ReserveOutcome {
  const existing = slots(db)[key];
  if (!existing) {
    slots(db)[key] = { key, status: "processing", fingerprint, createdAt: now, updatedAt: now };
    return { outcome: "reserved" };
  }
  if (existing.status === "completed" && existing.fingerprint === fingerprint && existing.campaignId) {
    return { outcome: "replay", campaignId: existing.campaignId };
  }
  if (existing.fingerprint !== fingerprint) {
    return { outcome: "mismatch", expected: existing.fingerprint, received: fingerprint };
  }
  existing.status = "processing";
  existing.updatedAt = now;
  return { outcome: "takeover" };
}

export function completeIdempotencySlot(db: Database, key: string, campaignId: string, now: string): void {
  const slot = slots(db)[key];
  if (!slot) {
    slots(db)[key] = {
      key,
      status: "completed",
      fingerprint: "",
      campaignId,
      createdAt: now,
      updatedAt: now
    };
    return;
  }
  slot.status = "completed";
  slot.campaignId = campaignId;
  slot.updatedAt = now;
}

export function failIdempotencySlot(db: Database, key: string, now: string): void {
  const slot = slots(db)[key];
  if (!slot) return;
  // Failed attempts never replay: a later retry with the same key takes over.
  slot.status = "failed";
  slot.updatedAt = now;
}

/* ------------------------- in-process single-flight ------------------------ */

const inflight = new Map<string, Promise<unknown>>();

/**
 * Serialize concurrent work under one lock key within this server instance.
 * Concurrent duplicates (double-click, double tab, retried-while-running)
 * await the live holder and share its result instead of creating twice.
 * Entries are always removed — a crashed holder settles (rejects) and every
 * waiter observes the settlement, so the lock can never stick.
 */
export async function withIdempotencyLock<T>(lockKey: string, work: () => Promise<T>): Promise<T> {
  const existing = inflight.get(lockKey);
  if (existing) return existing as Promise<T>;
  const promise = work();
  inflight.set(lockKey, promise);
  try {
    return await promise;
  } finally {
    if (inflight.get(lockKey) === promise) inflight.delete(lockKey);
  }
}
