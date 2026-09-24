import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publicDkgStatus } from "./adapter";
import type { DkgAdapter, KaRecord } from "./adapter";
import { containsOperationalDetail, sanitizeDkgError } from "./public-errors";
import type { CliTransport } from "./transports";
import type { KaEnvelope } from "./schemas";
import { dkgStatusResponse } from "./status";
import { emptyDb } from "../store";
import type { Campaign, Database, DerivativeReceipt, PermissionPassport } from "../types";

/**
 * DKG exposure audit (no network, no provider calls, no paid dispatch):
 * - every /api/dkg request requires an authenticated session (fails closed
 *   with no request context; no data returned);
 * - no SPARQL-accepting handler is exposed to the browser (removed route
 *   surface, not just UI);
 * - no identifier-parameterized DKG read exists, so no cross-workspace
 *   identifier can be requested - the session workspace binds all reads;
 * - workspace health responses carry no endpoint/hostname/command/path
 *   material;
 * - private records publish locally with zero shared (CLI/transport)
 *   calls and a truthful "local" status; shared records still use the
 *   shared path with a "shared" status;
 * - adapter and route failures sanitize to static messages (no env echo).
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pf-dkg-exposure-"));
process.env.PERMITFRAME_DATA_DIR = path.join(tmpRoot, "data");
process.env.DKG_CONTEXT_GRAPH_ID = "test-context-graph";

after(() => {
  delete process.env.PERMITFRAME_DATA_DIR;
  delete process.env.DKG_CONTEXT_GRAPH_ID;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("static product health projection", () => {
  it("returns mode + healthy + one fixed line, nothing else", () => {
    assert.deepEqual(publicDkgStatus("edge-node", true), {
      mode: "edge-node",
      healthy: true,
      status: "Proof ledger connected."
    });
    assert.deepEqual(publicDkgStatus("edge-node", false), {
      mode: "edge-node",
      healthy: false,
      status: "Proof ledger is temporarily unavailable."
    });
    assert.deepEqual(publicDkgStatus("local-evidence", true), {
      mode: "local-evidence",
      healthy: true,
      status: "Proof ledger connected."
    });
  });

  it("projected health carries no operational detail", () => {
    for (const projected of [publicDkgStatus("edge-node", true), publicDkgStatus("edge-node", false)]) {
      assert.equal(containsOperationalDetail(JSON.stringify(projected)), false);
    }
  });
});

describe("dkg route surface", () => {
  it("exposes GET but no SPARQL-accepting POST", async () => {
    const route = await import("../../app/api/dkg/route");
    assert.equal(typeof route.GET, "function");
    assert.equal((route as Record<string, unknown>).POST, undefined);
  });

  it("unauthenticated requests get a real HTTP 401 with zero adapter contact", async () => {
    const calls = { health: 0, listAssets: 0 };
    let loaderCalls = 0;
    const res = await dkgStatusResponse(null, fakeDkg({ calls }), () => {
      loaderCalls += 1;
      return Promise.resolve(null);
    });
    assert.ok(res instanceof Response);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Authentication required" });
    assert.deepEqual(calls, { health: 0, listAssets: 0 });
    assert.equal(loaderCalls, 0);
  });
});

function passportRow(id: string, ual?: string): PermissionPassport {
  return {
    id,
    creatorId: "c1",
    creatorName: "Creator",
    sourceMediaIds: [],
    platforms: ["instagram"],
    countries: ["GR"],
    allowedTransformations: ["edit"],
    validFrom: "2026-01-01",
    validUntil: "2027-01-01",
    status: "active",
    attestation: { method: "creator-consent-link", consentedAt: "2026-01-01", declaration: "ok" },
    visibility: "public",
    ...(ual ? { ual } : {})
  };
}

function receiptRow(id: string, campaignId: string): DerivativeReceipt {
  return {
    id,
    campaignId,
    jobId: `job_${id}`,
    label: id,
    mediaType: "image",
    format: "1:1",
    outputUrl: "https://cdn.example/o.png",
    capability: "flux-dev",
    promptHash: "hash",
    claimsUsed: [],
    derivedFrom: { sourceMediaId: "m1", passportId: "pa1", productFactsId: "f1" },
    generatedAt: "2026-01-01T00:00:00.000Z",
    visibility: "shared"
  };
}

function campaignRow(id: string, receipts: DerivativeReceipt[]): Campaign {
  return {
    id,
    title: id,
    brand: "brand",
    productName: "product",
    request: {
      platform: "instagram",
      country: "GR",
      requestedClaims: [],
      transformation: "image",
      creativeBrief: "A sufficiently long creative brief."
    },
    status: "draft",
    jobs: [],
    receipts,
    creatorId: "c1",
    sourceMediaId: "m1",
    passportId: "pa1",
    productFactsId: "f1",
    comments: [],
    captions: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function assetRow(over: Partial<KaRecord> & { name: string }): KaRecord {
  return {
    ual: "",
    evidenceUri: undefined,
    explorerUrl: "",
    publicationStatus: "shared",
    content: {},
    publishedAt: "",
    mode: "edge-node",
    ...over
  };
}

function fakeDkg(over: {
  mode?: "edge-node" | "local-evidence";
  healthy?: boolean;
  throwHealth?: boolean;
  assets?: KaRecord[];
  calls?: { health: number; listAssets: number };
}): DkgAdapter {
  const calls = over.calls ?? { health: 0, listAssets: 0 };
  const mode = over.mode ?? "edge-node";
  return {
    mode,
    health: async () => {
      calls.health += 1;
      if (over.throwHealth) throw new Error("dkg CLI failed (status ): boom");
      return { mode, healthy: over.healthy ?? true, detail: "internal detail never forwarded" };
    },
    publish: async () => {
      throw new Error("not under test");
    },
    publishVerifiable: async () => {
      throw new Error("not under test");
    },
    get: async () => null,
    sparql: async () => [],
    findApplicablePassports: async () => [],
    listPassports: async () => [],
    findProductFacts: async () => null,
    listAssets: async () => {
      calls.listAssets += 1;
      return (over.assets ?? []).map((a) => ({ ...a }));
    }
  };
}

const SESSION_A = { userId: "u-a", workspaceId: "ws-a", workspaceName: "A" };

function workspaceDbA(): Database {
  const db = emptyDb();
  db.passports.push(passportRow("pa1"), passportRow("pa2"), passportRow("pa9", "did:dkg:plate:A-ual"));
  db.campaigns.push(campaignRow("ca1", [receiptRow("ra1", "ca1")]));
  return db;
}

function workspaceDbB(): Database {
  const db = emptyDb();
  db.passports.push(passportRow("pb1"));
  return db;
}

function mixedAssets(): KaRecord[] {
  return [
    assetRow({ name: "a-passport", content: { "@id": "urn:permitframe:passport:pa1", "@type": "X" } }),
    assetRow({ name: "b-passport", content: { "@id": "urn:permitframe:passport:pb1", "@type": "X" } }),
    assetRow({
      name: "priv-shared",
      content: { "@id": "urn:permitframe:passport:pa2", "@type": "X", "pf:visibility": "private" }
    }),
    assetRow({
      name: "local-row",
      publicationStatus: "local",
      ual: "did:dkg:local/permitframe-passport-pa1",
      content: { "@id": "urn:permitframe:passport:pa1", "@type": "X" }
    }),
    assetRow({ name: "orphan", content: { "@id": "urn:permitframe:passport:zzz", "@type": "X" } }),
    assetRow({
      name: "anchored-receipt",
      publicationStatus: "anchored",
      ual: "did:dkg:test:receipt",
      content: { "@id": "urn:permitframe:receipt:ra1", "@type": "X" }
    }),
    assetRow({
      name: "ual-match",
      ual: "did:dkg:plate:A-ual",
      content: { "@id": "urn:unrelated:x", "@type": "X" }
    })
  ];
}

describe("workspace-safe record reads", () => {
  it("workspace A receives only its own shared records - never B, private, local, or orphan rows", async () => {
    const res = await dkgStatusResponse(SESSION_A, fakeDkg({ assets: mixedAssets() }), () =>
      Promise.resolve(workspaceDbA())
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { health: unknown; assets: KaRecord[] };
    assert.deepEqual(Object.keys(body).sort(), ["assets", "health"]);
    assert.deepEqual(
      body.assets.map((a) => a.name),
      ["a-passport", "anchored-receipt", "ual-match"]
    );
  });

  it("workspace B receives only its own record", async () => {
    const res = await dkgStatusResponse(
      { userId: "u-b", workspaceId: "ws-b", workspaceName: "B" },
      fakeDkg({ assets: mixedAssets() }),
      () => Promise.resolve(workspaceDbB())
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { assets: KaRecord[] };
    assert.deepEqual(body.assets.map((a) => a.name), ["b-passport"]);
  });

  it("health is the static projection with exact keys", async () => {
    const res = await dkgStatusResponse(SESSION_A, fakeDkg({ assets: [] }), () => Promise.resolve(workspaceDbA()));
    const body = (await res.json()) as { health: Record<string, unknown> };
    assert.deepEqual(body.health, { mode: "edge-node", healthy: true, status: "Proof ledger connected." });
    assert.equal(containsOperationalDetail(JSON.stringify(body)), false);
  });

  it("adapter health failure maps to the static unavailable line, records fail closed", async () => {
    const res = await dkgStatusResponse(SESSION_A, fakeDkg({ throwHealth: true, assets: mixedAssets() }), () =>
      Promise.resolve(workspaceDbA())
    );
    const body = (await res.json()) as { health: Record<string, unknown>; assets: KaRecord[] };
    assert.deepEqual(body.health, {
      mode: "edge-node",
      healthy: false,
      status: "Proof ledger is temporarily unavailable."
    });
    assert.deepEqual(
      body.assets.map((a) => a.name),
      ["a-passport", "anchored-receipt", "ual-match"]
    );
  });

  it("exposes a transaction hash only for the owning workspace's anchored Base Sepolia record", async () => {
    const db = workspaceDbA();
    const campaign = db.campaigns.find((row) => row.id === "ca1")!;
    const ual = "did:dkg:base:84532/0x31c83ac625c29ef7f4fabdb49ee68fb56b06977c/10";
    const txHash = `0x${"ab".repeat(32)}`;
    campaign.campaignUAL = ual;
    const res = await dkgStatusResponse(SESSION_A, fakeDkg({
      assets: [
        assetRow({
          name: "anchored-campaign",
          publicationStatus: "anchored",
          ual,
          txHash,
          content: { "@id": "urn:permitframe:campaign:ca1", "@type": "Campaign" }
        }),
        assetRow({
          name: "shared-must-not-leak-hash",
          publicationStatus: "shared",
          txHash,
          content: { "@id": "urn:permitframe:passport:pa1", "@type": "Passport" }
        })
      ]
    }), () => Promise.resolve(db));
    const body = (await res.json()) as { assets: KaRecord[] };
    assert.equal(body.assets.find((asset) => asset.name === "anchored-campaign")?.txHash, txHash);
    assert.equal(body.assets.find((asset) => asset.name === "shared-must-not-leak-hash")?.txHash, undefined);
  });
});

describe("edge-shaped shared records without content @id", () => {
  // Mirrors the real EdgeNodeAdapter.listAssets() shape: the graph subject
  // is the evidenceUri (a code-owned URN), content carries only @type, and
  // there is no @id to match on. Runs through dkgStatusResponse - the exact
  // helper/filter path behind GET /api/dkg.
  const SUBJECT = "urn:permitframe:passport:pa1";
  function edgeAssets(): KaRecord[] {
    return [
      assetRow({ name: "edge-shared", evidenceUri: SUBJECT, content: { "@type": "PermitFramePermissionPassport" } }),
      assetRow({
        name: "edge-local-twin",
        publicationStatus: "local",
        evidenceUri: SUBJECT,
        content: { "@type": "PermitFramePermissionPassport" }
      }),
      assetRow({
        name: "edge-private-twin",
        evidenceUri: SUBJECT,
        content: { "@type": "PermitFramePermissionPassport", "pf:visibility": "private" }
      })
    ];
  }

  it("the owning workspace receives the shared record", async () => {
    const res = await dkgStatusResponse(SESSION_A, fakeDkg({ assets: edgeAssets() }), () =>
      Promise.resolve(workspaceDbA())
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { assets: KaRecord[] };
    assert.deepEqual(body.assets.map((a) => a.name), ["edge-shared"]);
  });

  it("another workspace does not receive it, and private/local twins never appear", async () => {
    const res = await dkgStatusResponse(
      { userId: "u-b", workspaceId: "ws-b", workspaceName: "B" },
      fakeDkg({ assets: edgeAssets() }),
      () => Promise.resolve(workspaceDbB())
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { assets: KaRecord[] };
    assert.deepEqual(body.assets, []);
  });
});

describe("publish visibility enforcement", () => {
  function recordingTransport(calls: string[][], kaOutput?: string): CliTransport {
    return {
      run: async (args: string[]) => {
        calls.push(args);
        if (args[0] === "ka") {
          return kaOutput ?? "complete\nAssertion URI: urn:test:assertion-1\nMerkle root: 0xtest";
        }
        throw new Error(`unexpected shared command in test: ${args.join(" ")}`);
      }
    };
  }

  function ka(name: string): KaEnvelope {
    return {
      name,
      content: { "@id": `urn:test:${name}`, "@type": "Thing", "pf:visibility": "private" }
    };
  }

  it("private publish performs zero shared calls and stays local", async () => {
    const { EdgeNodeAdapter } = await import("./edge-node-adapter");
    const calls: string[][] = [];
    const record = await new EdgeNodeAdapter(recordingTransport(calls)).publish(ka("priv-1"), "private");
    assert.deepEqual(calls, []);
    assert.equal(record.publicationStatus, "local");
    assert.ok(record.ual.startsWith("did:dkg:local/"));
    assert.equal(record.mode, "local-evidence");
  });

  it("private verifiable publish never anchors - local, zero shared calls", async () => {
    const { EdgeNodeAdapter } = await import("./edge-node-adapter");
    const calls: string[][] = [];
    const record = await new EdgeNodeAdapter(recordingTransport(calls)).publishVerifiable(ka("priv-2"), "private");
    assert.deepEqual(calls, []);
    assert.equal(record.publicationStatus, "local");
  });

  it("shared publish still uses the shared path with shared status", async () => {
    const { EdgeNodeAdapter } = await import("./edge-node-adapter");
    const calls: string[][] = [];
    const record = await new EdgeNodeAdapter(recordingTransport(calls)).publish(ka("shared-1"), "shared");
    assert.ok(calls.length > 0);
    assert.ok(calls.some((c) => c[0] === "ka" && c.includes("--share")));
    assert.equal(record.publicationStatus, "shared");
    assert.equal(record.evidenceUri, "urn:test:assertion-1");
  });
});

describe("safe failure surfaces", () => {
  it("adapter bootstrap echoes never reach API errors", () => {
    const safe = sanitizeDkgError(new Error('Unsupported DKG_MODE="edge ". Use "edge" or omit it.'), "query");
    assert.equal(safe.message, "Something went wrong while contacting the proof service. Try again shortly.");
    assert.ok(!safe.message.includes("edge"));
  });

  it("SSH/hostname/path/command failures map to static messages", () => {
    for (const raw of [
      "dkg CLI failed (ka create ): Command failed: ssh -i /home/op/.ssh/id_ed25519 harsh@3.77.202.228",
      "connect ECONNREFUSED 127.0.0.1:9200",
      "C:\\Users\\harsh\\permitframe\\.data\\dkg\\x.json ENOENT"
    ]) {
      const safe = sanitizeDkgError(new Error(raw), "query");
      assert.ok(!safe.message.includes("3.77.202.228"));
      assert.ok(!safe.message.includes(".ssh"));
      assert.ok(!safe.message.includes("C:"));
    }
  });
});
