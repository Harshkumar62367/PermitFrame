import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { users, workspaces, workspaceState } from "./db/schema";
import type { Campaign, Database } from "./types";

dotenv.config({ path: ".env.local" });

const BASE = "http://localhost:3000";
const SHARE_TOKEN = "share_abcdef123456";
const WS_ID = "ws_test_public_links";
const USER_ID = "usr_test_public_links";

const VIEW_KEYS = [
  "allowedClaims", "brand", "captions", "country", "outputs", "platform", "productName", "title", "verificationRef"
];
const OUTPUT_KEYS = ["claimsUsed", "format", "id", "label", "mediaType", "outputUrl", "verifyUrl"];

function seedCampaign(): Campaign {
  return {
    id: "cmp_test_public_links",
    title: "Public Links Probe Pack",
    brand: "Verdi Steps",
    productName: "TerraRunner",
    request: {
      platform: "instagram",
      country: "GR",
      requestedClaims: ["made with recycled materials"],
      transformation: "image",
      creativeBrief: "A sufficiently long creative brief for the public-links probe."
    },
    status: "review",
    jobs: [
      {
        id: "job_probe",
        campaignId: "cmp_test_public_links",
        stageId: "keyframe",
        kind: "text-to-image",
        capability: "flux-schnell",
        prompt: "FULL PROMPT with secret art-direction sauce - must never go public",
        status: "ready_to_share",
        outputUrl: "https://example.com/out.png",
        startedAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    receipts: [
      {
        id: "rcp_probe",
        campaignId: "cmp_test_public_links",
        jobId: "job_probe",
        label: "Campaign keyframe (9:16)",
        mediaType: "image",
        format: "9:16",
        outputUrl: "https://example.com/out.png",
        outputHash: "hash_probe",
        capability: "flux-schnell",
        promptHash: "ph_probe",
        claimsUsed: ["made with recycled materials"],
        derivedFrom: { sourceMediaId: "med_secret", passportId: "pp_secret", productFactsId: "pf_secret" },
        generatedAt: "2026-01-01T00:00:00.000Z",
        costUsd: 0.0032,
        // Client-visible outputs are shared AND durably stored: private,
        // blocked, and not-yet-stored receipts never reach the share view
        // (see publicOutputsForShare), so the probe pack - which the tests
        // below expect to be listed - is shared and stored.
        storageStatus: "stored",
        visibility: "shared"
      }
    ],
    creatorId: "crt_secret",
    sourceMediaId: "med_secret",
    passportId: "pp_secret",
    productFactsId: "pf_secret",
    comments: [{ id: "cmt_1", author: "manager", text: "INTERNAL note: client is difficult", at: "2026-01-01T00:00:00.000Z" }],
    captions: [{ platform: "instagram", text: "Public caption", claimsUsed: ["made with recycled materials"], disclosure: "#ad" }],
    shareToken: SHARE_TOKEN,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    contextNote: "INTERNAL context note with contract terms - must never go public"
  };
}

function seedDb(): Database {
  return {
    creators: [{ id: "crt_secret", name: "Secret Creator", handle: "@secret" }],
    passports: [],
    sourceMedia: [
      { id: "med_secret", creatorId: "crt_secret", title: "secret source", type: "image", url: "https://internal.example.com/secret-source.mp4", hash: "h" }
    ],
    productFacts: [],
    campaigns: [seedCampaign()],
    consentInvites: [],
    events: [],
    idempotencyKeys: {},
    deletedCampaigns: []
  };
}

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
  return drizzle({ client: neon(process.env.DATABASE_URL), schema: { users, workspaces, workspaceState } });
}

async function serverUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/livepeer`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}

const SECRETS = [
  "crt_secret", "med_secret", "pp_secret", "pf_secret", "INTERNAL", "secret-source",
  "secret art-direction", "contract terms", "promptHash", "outputHash", "costUsd",
  "livepeerJobId", "workspaceId", "cookies", "SESSION_COOKIE"
];

describe("public share links", () => {
  let up = false;

  before(async () => {
    if (!process.env.DATABASE_URL) return;
    const d = db();
    await d.insert(users).values({ id: USER_ID, displayName: "Links Probe" }).onConflictDoNothing();
    await d.insert(workspaces).values({ id: WS_ID, ownerId: USER_ID, name: "Links Probe" }).onConflictDoNothing();
    await d.insert(workspaceState).values({ workspaceId: WS_ID, data: seedDb() }).onConflictDoUpdate({
      target: workspaceState.workspaceId,
      set: { data: seedDb(), updatedAt: new Date() }
    });
    up = await serverUp();
  });

  after(async () => {
    if (!process.env.DATABASE_URL) return;
    const d = db();
    await d.delete(workspaceState).where(eq(workspaceState.workspaceId, WS_ID));
    await d.delete(workspaces).where(eq(workspaces.id, WS_ID));
    await d.delete(users).where(eq(users.id, USER_ID));
  });

  it("anonymous share API serves exactly the whitelisted view", async (t) => {
    if (!up) return t.skip("dev server not running");
    // No cookie sent: incognito-equivalent.
    const r = await fetch(`${BASE}/api/share/${SHARE_TOKEN}`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(Object.keys(body), ["view"]);
    assert.deepEqual(Object.keys(body.view).sort(), VIEW_KEYS);
    assert.deepEqual(Object.keys(body.view.outputs[0]).sort(), OUTPUT_KEYS);
    assert.equal(body.view.outputs[0].verifyUrl, null);
    assert.equal(body.view.title, "Public Links Probe Pack");
    const dump = JSON.stringify(body);
    for (const secret of SECRETS) {
      assert.ok(!dump.includes(secret), `share API leaks: ${secret}`);
    }
  });

  it("malformed, legacy and unknown tokens 404 without data", async (t) => {
    if (!up) return t.skip("dev server not running");
    for (const bad of ["", "cmp_test_public_links", "rcp_probe", "did:dkg:otp:1/0xabc/1", "share_zzz", "share_ABCDEF123456", "share_000000000000"]) {
      const r = await fetch(`${BASE}/api/share/${bad}`);
      assert.equal(r.status, 404, `must 404: ${bad || "(empty)"}`);
    }
  });

  it("anonymous review submit appends one client note, rejects unknown tokens", async (t) => {
    if (!up) return t.skip("dev server not running");
    let r = await fetch(`${BASE}/api/share/${SHARE_TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved", clientName: "Probe Client", comment: "Looks good" })
    });
    assert.equal(r.status, 200);
    // External reviewer decisions are feedback only: the recorded status
    // stays "review" - only the authenticated owner flow may approve.
    assert.equal((await r.json()).status, "review");
    // Read back raw: exactly one new client comment, internal note untouched.
    const rows = await db()
      .select({ data: workspaceState.data })
      .from(workspaceState)
      .where(eq(workspaceState.workspaceId, WS_ID));
    const campaign = rows[0].data.campaigns.find((c) => c.shareToken === SHARE_TOKEN);
    assert.equal(campaign?.status, "review");
    const last = campaign?.comments.at(-1);
    assert.equal(last?.author, "Probe Client");
    assert.ok((last?.text ?? "").startsWith("[approved]"));
    assert.equal(campaign?.comments.filter((c) => c.author === "manager").length, 1);
    r = await fetch(`${BASE}/api/share/share_000000000000`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" })
    });
    assert.equal(r.status, 404);
  });

  it("anonymous share page renders only public data", async (t) => {
    if (!up) return t.skip("dev server not running");
    const r = await fetch(`${BASE}/share/${SHARE_TOKEN}`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes("Public Links Probe Pack"));
    assert.ok(html.includes("https://example.com/out.png"));
    for (const secret of SECRETS) {
      assert.ok(!html.includes(secret), `share page leaks: ${secret}`);
    }
    const bad = await fetch(`${BASE}/share/share_000000000000`);
    assert.equal(bad.status, 404);
    assert.ok((await bad.text()).includes("invalid or was removed"));
  });

  it("legacy verify links 404 with the branded recovery state, never data", async (t) => {
    if (!up) return t.skip("dev server not running");
    for (const legacy of ["cmp_test_public_links", "rcp_probe", "vrf_does_not_exist_000"]) {
      const r = await fetch(`${BASE}/verify/${legacy}`);
      assert.equal(r.status, 404);
      const html = await r.text();
      assert.ok(html.includes("has been replaced. Ask the campaign owner for a refreshed verification link"), `missing recovery copy for ${legacy}`);
      for (const secret of ["TerraRunner", "crt_secret", "INTERNAL", "secret-source", "Public Links Probe"]) {
        assert.ok(!html.includes(secret), `recovery page leaks for ${legacy}: ${secret}`);
      }
    }
    const api = await fetch(`${BASE}/api/verify/vrf_does_not_exist_000`);
    assert.equal(api.status, 404);
  });
});

describe("public surface field isolation (static)", () => {
  const root = process.cwd();
  // Strip comments first: documentation may NAME a forbidden dependency to
  // explain why it is absent; only real code references count.
  const code = (rel: string) =>
    fs
      .readFileSync(path.join(root, ...rel.split("/")), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/.*$/gm, "$1");

  it("public-share module never touches session/auth", () => {
    const source = code("src/server/public-share.ts");
    for (const banned of ["cookies", "SESSION_COOKIE", "loadDb", "requireCurrentSession", "next/headers", "./store", "./auth"]) {
      assert.ok(!source.includes(banned), `public-share.ts must not reference ${banned}`);
    }
  });

  it("public pages render whitelisted fields only", () => {
    for (const rel of ["src/app/share/[token]/page.tsx", "src/app/verify/[ref]/page.tsx"]) {
      const source = code(rel);
      for (const banned of ["sourceMedia", "contextNote", "comments", "cookies", "workspaceId", "credential", "secret", "wallet", "SESSION_COOKIE", "loadDb", "resolveShare"]) {
        assert.ok(!source.includes(banned), `${rel} must not reference ${banned}`);
      }
    }
  });
});
