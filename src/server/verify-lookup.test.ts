import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { verificationSnapshots } from "./db/schema";
import type { PublicVerificationSnapshot } from "./types";

dotenv.config({ path: ".env.local" });

const BASE = "http://localhost:3000";
const ref = `vrf_test_${Date.now().toString(36)}`;
const sharedRef = `vrf_test_shared_${Date.now().toString(36)}`;

const payload: PublicVerificationSnapshot = {
  ref,
  campaignId: "cmp_test",
  title: "Test pack",
  brand: "Verdi",
  productName: "TerraRunner",
  platform: "instagram",
  country: "GR",
  status: "approved",
  approvedAt: new Date().toISOString(),
  creatorName: "Maya",
  rightsSummary: { platforms: ["instagram"], countries: ["GR"], validUntil: "2027-01-01", status: "active" },
  verifiedClaims: [],
  brandRules: { brand: "Verdi", productName: "TerraRunner", approvedClaims: [] },
  captions: [],
  outputs: [],
  publicationStatus: "local",
  ual: null,
  explorerUrl: null
};

const sharedPayload: PublicVerificationSnapshot = {
  ...payload,
  ref: sharedRef,
  publicationStatus: "shared"
};

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
  return drizzle({ client: neon(process.env.DATABASE_URL), schema: { verificationSnapshots } });
}

async function serverUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/livepeer`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}

describe("anonymous verification reads", () => {
  let up = false;

  before(async () => {
    if (!process.env.DATABASE_URL) return;
    await db()
      .insert(verificationSnapshots)
      .values({ ref, campaignId: "cmp_test", payload });
    await db()
      .insert(verificationSnapshots)
      .values({ ref: sharedRef, campaignId: "cmp_test", payload: sharedPayload });
    up = await serverUp();
  });

  after(async () => {
    if (!process.env.DATABASE_URL) return;
    await db().delete(verificationSnapshots).where(eq(verificationSnapshots.ref, ref));
    await db().delete(verificationSnapshots).where(eq(verificationSnapshots.ref, sharedRef));
  });

  it("unknown ref resolves to a clear miss (never a throw)", async (t) => {
    if (!process.env.DATABASE_URL) return t.skip("DATABASE_URL missing");
    const rows = await db()
      .select({ payload: verificationSnapshots.payload })
      .from(verificationSnapshots)
      .where(eq(verificationSnapshots.ref, "vrf_does_not_exist_000"))
      .limit(1);
    assert.equal(rows.length, 0);
  });

  it("valid ref returns the persisted snapshot with no private fields", async (t) => {
    if (!process.env.DATABASE_URL) return t.skip("DATABASE_URL missing");
    const rows = await db()
      .select({ payload: verificationSnapshots.payload })
      .from(verificationSnapshots)
      .where(eq(verificationSnapshots.ref, ref))
      .limit(1);
    assert.equal(rows.length, 1);
    const dump = JSON.stringify(rows[0].payload);
    for (const key of ["workspaceId", "wallet", "session", "secret", "credential", "creatorId", "declaration", "prohibitedClaims", "prompt:"]) {
      assert.ok(!dump.includes(`"${key}"`), `leaked private key: ${key}`);
    }
  });

  it("anonymous unknown ref → 404, never 500", async (t) => {
    if (!up) return t.skip("dev server not running");
    const r = await fetch(`${BASE}/verify/vrf_does_not_exist_000`);
    assert.equal(r.status, 404);
  });

  it("anonymous valid ref → 200 with honest non-anchored status", async (t) => {
    if (!up) return t.skip("dev server not running");
    if (!process.env.DATABASE_URL) return t.skip("DATABASE_URL missing");
    const r = await fetch(`${BASE}/verify/${ref}`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes("Campaign record saved"), "non-anchored snapshot must show saved status");
    assert.ok(!html.includes("Public verification ready"), "non-anchored snapshot must not claim public readiness");
  });

  it("anonymous shared ref → 200 saved status, never public proof", async (t) => {
    if (!up) return t.skip("dev server not running");
    if (!process.env.DATABASE_URL) return t.skip("DATABASE_URL missing");
    const r = await fetch(`${BASE}/verify/${sharedRef}`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes("Campaign record saved"), "shared snapshot must show saved status");
    assert.ok(!html.includes("Public verification ready"), "shared snapshot must not claim public readiness");
    assert.ok(!html.toLowerCase().includes("on-chain"), "shared snapshot must not mention on-chain proof");
  });

  it("anonymous API valid ref → 200 with allowlisted fields only", async (t) => {
    if (!up) return t.skip("dev server not running");
    if (!process.env.DATABASE_URL) return t.skip("DATABASE_URL missing");
    const r = await fetch(`${BASE}/api/verify/${ref}`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { found?: unknown; snapshot?: Record<string, unknown> };
    assert.equal(body.found, true);
    const topKeys = Object.keys(body).sort();
    assert.deepEqual(topKeys, ["found", "snapshot"]);
    const allowedSnapshotKeys = [
      "approvedAt", "brand", "brandRules", "campaignId", "captions", "country", "creatorName",
      "explorerUrl", "outputs", "platform", "productName", "publicationStatus", "ref",
      "rightsSummary", "status", "title", "ual", "verifiedClaims"
    ].sort();
    assert.deepEqual(Object.keys(body.snapshot ?? {}).sort(), allowedSnapshotKeys);
    const dump = JSON.stringify(body);
    for (const key of ["workspaceId", "userId", "wallet", "session", "token", "secret", "credential", "password", "creatorId", "sourceMediaId", "passportId", "productFactsId", "consent", "declaration", "prohibitedClaims", "evidenceNotes", "comment", "prompt", "contact", "email", "phone", "contract", "outputHash"]) {
      assert.ok(!dump.includes(`"${key}"`), `API leaked private key: ${key}`);
    }
  });

  it("anonymous API unknown ref → 404, never 500", async (t) => {
    if (!up) return t.skip("dev server not running");
    const r = await fetch(`${BASE}/api/verify/vrf_does_not_exist_000`);
    assert.equal(r.status, 404);
  });
});
