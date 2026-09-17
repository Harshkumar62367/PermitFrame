import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildPublicSnapshot } from "./verification-snapshot";
import type { Campaign, PermissionPassport, ProductFacts } from "./types";

const campaign = {
  id: "cmp_test123",
  title: "Test pack",
  brand: "Verdi",
  productName: "TerraRunner",
  request: {
    platform: "instagram",
    country: "GR",
    requestedClaims: ["made with recycled materials"],
    transformation: "image",
    creativeBrief: "Golden hour rooftop shot"
  },
  status: "approved",
  jobs: [],
  receipts: [
    {
      id: "rcpt_1",
      campaignId: "cmp_test123",
      jobId: "job_1",
      label: "Campaign keyframe (9:16)",
      mediaType: "image",
      format: "9:16",
      outputUrl: "https://cdn.example/o.jpg",
      outputHash: "abc",
      capability: "flux-schnell",
      promptHash: "def",
      claimsUsed: ["made with recycled materials"],
      derivedFrom: { sourceMediaId: "media_1", passportId: "passport_1", productFactsId: "facts_1" },
      generatedAt: "2026-09-17T00:00:00.000Z",
      visibility: "shared"
    }
  ],
  creatorId: "creator_1",
  sourceMediaId: "media_1",
  passportId: "passport_1",
  productFactsId: "facts_1",
  comments: [{ id: "c1", author: "manager", text: "internal note", at: "2026-09-17T00:00:00.000Z" }],
  captions: [{ platform: "instagram", text: "Hello", claimsUsed: [], disclosure: "sponsored" }],
  preflight: { allowedClaims: ["made with recycled materials"] },
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z"
} as unknown as Campaign;

const passport = {
  creatorName: "Maya",
  platforms: ["instagram"],
  countries: ["GR"],
  validUntil: "2027-01-01",
  status: "active"
} as unknown as PermissionPassport;

const facts = {
  brand: "Verdi",
  productName: "TerraRunner",
  approvedClaims: ["made with recycled materials"],
  prohibitedClaims: ["waterproof"]
} as unknown as ProductFacts;

const BANNED_KEYS = [
  "workspaceId",
  "workspace",
  "userId",
  "user",
  "wallet",
  "session",
  "token",
  "secret",
  "credential",
  "password",
  "creatorId",
  "sourceMediaId",
  "passportId",
  "productFactsId",
  "consent",
  "declaration",
  "prohibitedClaims",
  "evidenceNotes",
  "note",
  "comment",
  "prompt:"
];

describe("buildPublicSnapshot", () => {
  it("exposes only intentional public fields", () => {
    const s = buildPublicSnapshot({ ref: "vrf_test", campaign, passport, facts });
    const dump = JSON.stringify(s);
    for (const key of BANNED_KEYS) {
      assert.ok(!dump.includes(`"${key}"`), `leaked private key: ${key}`);
    }
    assert.equal(s.ref, "vrf_test");
    assert.equal(s.status, "approved");
    assert.equal(s.outputs.length, 1);
    assert.equal(s.verifiedClaims.length, 1);
  });

  it("sets UAL/explorer only for genuinely anchored records", () => {
    const anchored = buildPublicSnapshot({
      ref: "vrf_a",
      campaign: { ...campaign, publicationStatus: "anchored", campaignUAL: "did:dkg:0xabc/1" } as Campaign,
      passport,
      facts
    });
    assert.equal(anchored.ual, "did:dkg:0xabc/1");
    assert.ok(anchored.explorerUrl?.startsWith("https://dkg.origintrail.io/explore?ual="));

    for (const status of ["local", "shared", "failed", undefined] as const) {
      const s = buildPublicSnapshot({
        ref: "vrf_x",
        campaign: { ...campaign, publicationStatus: status, campaignUAL: "did:dkg:0xabc/1" } as Campaign,
        passport,
        facts
      });
      assert.equal(s.ual, null, `status ${status} must not carry a UAL`);
      assert.equal(s.explorerUrl, null, `status ${status} must not carry an explorer link`);
      assert.equal(s.publicationStatus, status ?? null);
    }
  });

  it("never fabricates identifiers for missing records", () => {
    const s = buildPublicSnapshot({
      ref: "vrf_x",
      campaign: { ...campaign, publicationStatus: "failed" } as Campaign,
      passport: null,
      facts: null
    });
    assert.equal(s.ual, null);
    assert.equal(s.explorerUrl, null);
    assert.equal(s.creatorName, "Creator");
    assert.equal(s.outputs.length, 1);
  });
});

describe("verify module session isolation", () => {
  it("never invokes session/auth loading", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "server", "verify.ts"), "utf8");
    for (const banned of ["loadDb", "requireCurrentSession", "SESSION_COOKIE", "next/headers", "./store", "../store", "./auth", "../auth", "cookies()"]) {
      assert.ok(!source.includes(banned), `verify.ts must not reference ${banned}`);
    }
  });
});
