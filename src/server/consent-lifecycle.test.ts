import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ConsentInvite, Database, PermissionPassport } from "./types";
import { emptyDb } from "./store";
import { attestGuard, consentLifecycle } from "./consent-validation";
import {
  declineConsentRequest,
  markConsentViewed,
  withConsentTransitionLock,
  type ConsentWorkspaceStore
} from "./platform";

/**
 * Sessionless public consent lifecycle: viewed-marking and decline persist
 * through an explicit workspace ID (never session-bound loadDb/updateDb),
 * attest-vs-decline serializes on one transition lock with exactly one
 * terminal winner, and decline never mints a passport or touches DKG.
 * All workspace I/O runs through an injected in-memory store - no session,
 * no network (fetch is stubbed to throw), no Neon.
 */

const WS = "ws_consent_test";
const TOKEN = "invite_test_1";

let realFetch: typeof fetch | undefined;

afterEach(() => {
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = undefined;
});

function throwOnNetwork(): void {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network disabled in consent lifecycle tests");
  }) as typeof fetch;
}

function memoryStore(seed: Database, seen: string[]): { store: ConsentWorkspaceStore; read: () => Database } {
  let current: Database = seed;
  return {
    store: {
      loadWorkspace: async (workspaceId: string) => {
        seen.push(`load:${workspaceId}`);
        return structuredClone(current);
      },
      writeWorkspace: async (workspaceId: string, mutator: (db: Database) => void) => {
        seen.push(`write:${workspaceId}`);
        const next = structuredClone(current);
        mutator(next);
        current = next;
      }
    },
    read: () => current
  };
}

function pendingInvite(token = TOKEN): ConsentInvite {
  return {
    token,
    creatorId: "creator_maya",
    draft: {
      creatorId: "creator_maya",
      platforms: ["instagram"],
      countries: ["GR"],
      allowedTransformations: [],
      validUntil: "2027-03-01",
      sourceMediaIds: ["media_1"]
    },
    status: "pending",
    purpose: "Spring launch",
    linkExpiresAt: "2027-04-01",
    createdAt: "2027-01-01T00:00:00.000Z",
    version: 1
  };
}

function seedDb(invite: ConsentInvite): Database {
  const db = emptyDb();
  db.creators.push({ id: "creator_maya", name: "Maya", handle: "@maya" });
  db.sourceMedia.push({
    id: "media_1",
    creatorId: "creator_maya",
    title: "Portrait",
    type: "image",
    url: "https://cdn.example/m1.png",
    hash: "h1"
  });
  db.consentInvites.push(invite);
  return db;
}

/** Route-faithful approval side: guard re-check inside the lock, then mint. No DKG here by construction. */
async function approveUnderLock(
  store: ConsentWorkspaceStore,
  token: string,
  passportId: string
): Promise<{ ok: true; passportId: string } | { ok: false; error: string }> {
  return withConsentTransitionLock(token, async () => {
    const db = await store.loadWorkspace(WS);
    const row = db.consentInvites.find((i) => i.token === token);
    if (!row) return { ok: false, error: "Consent link not found" };
    const gate = attestGuard(consentLifecycle(row));
    if (!gate.ok) return { ok: false, error: gate.error };
    const passport: PermissionPassport = {
      id: passportId,
      creatorId: row.creatorId,
      creatorName: "Maya",
      sourceMediaIds: row.draft.sourceMediaIds,
      platforms: row.draft.platforms,
      countries: row.draft.countries,
      allowedTransformations: row.draft.allowedTransformations,
      validFrom: "2027-01-10",
      validUntil: row.draft.validUntil,
      status: "active",
      attestation: {
        method: "creator-consent-link",
        consentedAt: "2027-01-10T00:00:00.000Z",
        declaration: "test declaration"
      },
      visibility: "public"
    };
    await store.writeWorkspace(WS, (d) => {
      d.passports.push(passport);
      const r = d.consentInvites.find((i) => i.token === token);
      if (!r) return;
      r.status = "approved";
      r.passportId = passportId;
      r.decision = { outcome: "approved", at: "2027-01-10T00:00:00.000Z" };
      d.events.push({
        id: "evt_test_approve",
        at: "2027-01-10T00:00:00.000Z",
        kind: "consent.attested",
        summary: "test approval",
        refs: [passportId]
      });
    });
    return { ok: true, passportId };
  });
}

describe("sessionless public viewed marking", () => {
  it("persists pending → viewed using the explicit workspace ID", async () => {
    throwOnNetwork();
    const seen: string[] = [];
    const { store, read } = memoryStore(seedDb(pendingInvite()), seen);
    await markConsentViewed(TOKEN, WS, store);
    const row = read().consentInvites[0];
    assert.equal(row.status, "viewed");
    assert.ok(row.viewedAt, "viewed timestamp recorded");
    assert.ok(seen.includes(`write:${WS}`), "write went to the explicit workspace");
    // Idempotent: a second open changes nothing and publishes nothing.
    await markConsentViewed(TOKEN, WS, store);
    assert.equal(read().consentInvites[0].status, "viewed");
    assert.deepEqual(read().events, []);
    assert.deepEqual(read().passports, []);
  });
});

describe("sessionless public decline", () => {
  it("persists declined plus the local note, with no passport and no DKG", async () => {
    throwOnNetwork();
    const seen: string[] = [];
    const { store, read } = memoryStore(seedDb(pendingInvite()), seen);
    await declineConsentRequest(TOKEN, "  Not right for this brand. ", WS, store);
    const db = read();
    const row = db.consentInvites[0];
    assert.equal(row.status, "declined");
    assert.deepEqual(row.decision, {
      outcome: "declined",
      note: "Not right for this brand.",
      at: row.decision?.at
    });
    assert.ok(seen.includes(`write:${WS}`), "write went to the explicit workspace");
    assert.deepEqual(db.passports, [], "decline mints no passport");
    assert.equal(
      db.events.filter((e) => e.kind === "consent.attested").length,
      0,
      "decline publishes no attestation event"
    );
    assert.equal(db.events.filter((e) => e.kind === "consent.declined").length, 1);
  });

  it("caps an overlong decline note locally", async () => {
    const seen: string[] = [];
    const { store, read } = memoryStore(seedDb(pendingInvite()), seen);
    await declineConsentRequest(TOKEN, "x".repeat(600), WS, store);
    assert.equal(read().consentInvites[0].decision?.note?.length, 500);
  });
});

describe("attest vs decline serialization", () => {
  it("decline win refuses attestation with no passport and no attestation event", async () => {
    throwOnNetwork();
    const seen: string[] = [];
    const { store, read } = memoryStore(seedDb(pendingInvite()), seen);
    const declineTask = withConsentTransitionLock(TOKEN, () =>
      declineConsentRequest(TOKEN, "Passing on this one.", WS, store)
    );
    const approveTask = approveUnderLock(store, TOKEN, "passport_race_1");
    const [, approveResult] = await Promise.all([declineTask, approveTask]);
    assert.deepEqual(approveResult, {
      ok: false,
      error: "This request was declined - no attestation was recorded."
    });
    const db = read();
    assert.equal(db.consentInvites[0].status, "declined");
    assert.deepEqual(db.passports, [], "loser mints no passport");
    assert.equal(db.events.filter((e) => e.kind === "consent.attested").length, 0);
    assert.equal(db.events.filter((e) => e.kind === "consent.declined").length, 1);
  });

  it("approval win refuses decline with the already-attested error and no decline event", async () => {
    throwOnNetwork();
    const seen: string[] = [];
    const { store, read } = memoryStore(seedDb(pendingInvite()), seen);
    const approveTask = approveUnderLock(store, TOKEN, "passport_race_2");
    const declineTask = withConsentTransitionLock(TOKEN, () =>
      declineConsentRequest(TOKEN, "Too late.", WS, store)
    );
    const [approveResult, declineError] = await Promise.all([
      approveTask,
      declineTask.then(
        () => "no-error",
        (e: unknown) => (e instanceof Error ? e.message : String(e))
      )
    ]);
    assert.deepEqual(approveResult, { ok: true, passportId: "passport_race_2" });
    assert.equal(declineError, "Consent already attested");
    const db = read();
    assert.equal(db.consentInvites[0].status, "approved");
    assert.equal(db.passports.length, 1);
    assert.equal(db.events.filter((e) => e.kind === "consent.declined").length, 0);
    assert.equal(db.events.filter((e) => e.kind === "consent.attested").length, 1);
  });
});
