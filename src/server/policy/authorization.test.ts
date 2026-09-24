import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Campaign, Database, PermissionPassport, ProductFacts, SourceMedia } from "../types";
import { setRunStore, memoryStore } from "../livepeer/run-store";
import { submitRun } from "../livepeer/run-submit";
import { pumpRun } from "../livepeer/runner";
import { emptyDb } from "../store";
import {
  checkAuthorizationBinding,
  revalidateCampaignAuthorization,
  validateRenewalAttestation,
  type AuthorizationEvidence
} from "./authorization";
import { rowToPassport } from "../dkg/file-adapter";
import { buildRenewalConsentInput } from "../platform";

/**
 * Campaign authorization revalidation. Pure binding decisions run with no
 * DKG and no database; live-vs-workspace tiers run against injected fake
 * adapters (never getDkg()); the submit gate runs against the memory
 * store with DKG forced unsupported so Tier-3 workspace rows decide
 * deterministically. No provider calls anywhere in this file.
 */

const TODAY = "2026-09-24";

function media(over: Partial<SourceMedia> = {}): SourceMedia {
  return {
    id: "m1",
    creatorId: "c1",
    title: "approved creator media",
    type: "image",
    url: "https://source.example/approved.png",
    hash: "hash",
    ...over
  };
}

function facts(over: Partial<ProductFacts> = {}): ProductFacts {
  return {
    id: "f1",
    brand: "Verdi",
    productName: "TerraRunner",
    approvedClaims: ["a"],
    prohibitedClaims: [],
    guidelines: [],
    evidenceNotes: "e",
    visibility: "shared",
    ...over
  };
}

function passport(id: string, over: Partial<PermissionPassport> = {}): PermissionPassport {
  return {
    id,
    creatorId: "c1",
    creatorName: "Creator",
    sourceMediaIds: ["m1"],
    platforms: ["instagram"],
    countries: ["GR"],
    allowedTransformations: ["edit", "animate"],
    validFrom: "2026-01-01",
    validUntil: "2027-01-01",
    status: "active",
    attestation: { method: "creator-consent-link", consentedAt: "2026-01-01", declaration: "ok" },
    visibility: "public",
    ...over
  };
}

function campaign(): AuthorizationEvidence["campaign"] {
  return {
    id: "cmp_authz",
    creatorId: "c1",
    sourceMediaId: "m1",
    passportId: "pp_selected",
    productFactsId: "f1",
    brand: "Verdi",
    productName: "TerraRunner",
    request: {
      platform: "instagram",
      country: "GR",
      requestedClaims: [],
      transformation: "video",
      creativeBrief: "A sufficiently long creative brief."
    }
  };
}

function evidence(over: Partial<AuthorizationEvidence> = {}): AuthorizationEvidence {
  return {
    campaign: campaign(),
    media: media(),
    facts: facts(),
    passport: passport("pp_selected"),
    liveReachable: true,
    today: TODAY,
    ...over
  };
}

describe("exact binding decisions", () => {
  it("an exactly matching permission succeeds", () => {
    const r = checkAuthorizationBinding(evidence());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.passport.id, "pp_selected");
  });

  it("expired permission blocks with the expiry date", () => {
    const r = checkAuthorizationBinding(evidence({ passport: passport("pp_selected", { validUntil: "2026-09-01" }) }));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /expired on 2026-09-01/);
    assert.match(r.error, /fresh consent/);
  });

  it("revoked permission blocks", () => {
    const r = checkAuthorizationBinding(evidence({ passport: passport("pp_selected", { status: "revoked" }) }));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /has been revoked/);
  });

  it("a future-dated permission blocks until valid", () => {
    const r = checkAuthorizationBinding(evidence({ passport: passport("pp_selected", { validFrom: "2026-10-01" }) }));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /not valid until 2026-10-01/);
  });

  it("missing source media and creator mismatch block", () => {
    const missing = checkAuthorizationBinding(evidence({ media: undefined }));
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.error, /source media is no longer in this workspace/);
    const wrongCreator = checkAuthorizationBinding(evidence({ media: media({ creatorId: "c2" }) }));
    assert.equal(wrongCreator.ok, false);
    if (!wrongCreator.ok) assert.match(wrongCreator.error, /does not belong to the campaign creator/);
  });

  it("a sibling passport for the same creator but a different media never authorizes", () => {
    const sibling = checkAuthorizationBinding(
      evidence({ passport: passport("pp_selected", { sourceMediaIds: ["m9"] }) })
    );
    assert.equal(sibling.ok, false);
    if (!sibling.ok) assert.match(sibling.error, /does not cover the selected source media/);
  });

  it("a passport naming no media fails closed as legacy ambiguity", () => {
    const legacy = checkAuthorizationBinding(
      evidence({ passport: passport("pp_selected", { sourceMediaIds: [] }) })
    );
    assert.equal(legacy.ok, false);
    if (!legacy.ok) assert.match(legacy.error, /names no approved media/);
  });

  it("a passport for another creator never authorizes", () => {
    const other = checkAuthorizationBinding(
      evidence({ passport: passport("pp_selected", { creatorId: "c2" }) })
    );
    assert.equal(other.ok, false);
    if (!other.ok) assert.match(other.error, /belongs to a different creator/);
  });

  it("facts are required with claims and matched whenever present", () => {
    const ev = evidence();
    ev.campaign.request.requestedClaims = ["a"];
    const missing = checkAuthorizationBinding({ ...ev, facts: undefined });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.error, /product facts.*missing/);
    const mismatch = checkAuthorizationBinding({ ...ev, facts: facts({ brand: "Other" }) });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.match(mismatch.error, /do not match this campaign's brand/);
    assert.equal(checkAuthorizationBinding(ev).ok, true);
    const noClaims = evidence();
    assert.equal(checkAuthorizationBinding({ ...noClaims, facts: undefined }).ok, true);
  });

  it("prohibited and newly-absent claims block production after preflight", () => {
    const ev = evidence();
    ev.campaign.request.requestedClaims = ["a", "b"];
    const prohibited = checkAuthorizationBinding({
      ...ev,
      facts: facts({ approvedClaims: ["a", "b"], prohibitedClaims: ["b"] })
    });
    assert.equal(prohibited.ok, false);
    if (!prohibited.ok) assert.match(prohibited.error, /"b" is on the prohibited-claims list/);
    const removed = checkAuthorizationBinding({ ...ev, facts: facts({ approvedClaims: ["a"] }) });
    assert.equal(removed.ok, false);
    if (!removed.ok) assert.match(removed.error, /"b" is not supported by any verified product fact/);
  });

  it("platform, country, and transformation mismatches block", () => {
    const platform = checkAuthorizationBinding(evidence({ passport: passport("pp_selected", { platforms: ["tiktok"] }) }));
    assert.equal(platform.ok, false);
    if (!platform.ok) assert.match(platform.error, /does not cover instagram/);
    const country = checkAuthorizationBinding(evidence({ passport: passport("pp_selected", { countries: ["DE"] }) }));
    assert.equal(country.ok, false);
    if (!country.ok) assert.match(country.error, /does not cover GR/);
    const noAnimate = checkAuthorizationBinding(
      evidence({ passport: passport("pp_selected", { allowedTransformations: ["edit"] }) })
    );
    assert.equal(noAnimate.ok, false);
    if (!noAnimate.ok) assert.match(noAnimate.error, /animating/);
    const noEdit = checkAuthorizationBinding(
      evidence({ passport: passport("pp_selected", { allowedTransformations: ["animate"] }) })
    );
    assert.equal(noEdit.ok, false);
    if (!noEdit.ok) assert.match(noEdit.error, /editing/);
  });

  it("absent passport fails closed with guidance, live or not", () => {
    const live = checkAuthorizationBinding(evidence({ passport: undefined, liveReachable: true }));
    assert.equal(live.ok, false);
    if (!live.ok) {
      assert.match(live.error, /pp_selected/);
      assert.match(live.error, /fresh consent/);
    }
    const down = checkAuthorizationBinding(evidence({ passport: undefined, liveReachable: false }));
    assert.equal(down.ok, false);
    if (!down.ok) assert.match(down.error, /ledger is unreachable/);
  });
});

describe("live binding never substitutes a sibling passport", () => {
  function fakeDkg(rows: PermissionPassport[]) {
    return {
      listPassports: async () => rows.map((r) => ({ ...r }))
    };
  }

  function campaignRow(): Campaign {
    return {
      ...(campaign() as unknown as Record<string, unknown>),
      status: "draft",
      jobs: [],
      receipts: [],
      sourceMediaId: "m1",
      passportId: "pp_selected",
      productFactsId: "f1",
      comments: [],
      captions: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    } as unknown as Campaign;
  }

  function db(): Database {
    const d = emptyDb();
    d.sourceMedia.push(media());
    return d;
  }

  it("another passport for the same creator does not authorize", async () => {
    const r = await revalidateCampaignAuthorization(
      campaignRow(),
      db(),
      fakeDkg([passport("pp_other")]) as never,
      TODAY
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /pp_selected/);
    assert.ok(!r.error.includes("pp_other") || r.error.includes("pp_selected"));
  });

  it("the exact live passport authorizes", async () => {
    const r = await revalidateCampaignAuthorization(
      campaignRow(),
      db(),
      fakeDkg([passport("pp_other"), passport("pp_selected")]) as never,
      TODAY
    );
    assert.equal(r.ok, true);
  });

  it("an unreachable ledger falls back to a valid workspace row", async () => {
    const throwing = { listPassports: async (): Promise<never[]> => { throw new Error("boom"); } };
    const d = db();
    d.passports.push(passport("pp_selected"));
    const ok = await revalidateCampaignAuthorization(campaignRow(), d, throwing as never, TODAY);
    assert.equal(ok.ok, true);
  });

  it("an unreachable ledger with no workspace row fails closed", async () => {
    const throwing = { listPassports: async (): Promise<never[]> => { throw new Error("boom"); } };
    const r = await revalidateCampaignAuthorization(campaignRow(), db(), throwing as never, TODAY);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /ledger is unreachable/);
  });
});

describe("renewal requires fresh creator attestation", () => {
  it("refuses without attestation", () => {
    assert.deepEqual(validateRenewalAttestation(undefined), {
      ok: false,
      error:
        "Permission expiry can only be extended with a new creator consent - send a fresh consent request instead of renewing."
    });
    assert.equal(validateRenewalAttestation({ consentedAt: "", declaration: "" }).ok, false);
    assert.equal(validateRenewalAttestation({ consentedAt: "2026-09-24", declaration: "   " }).ok, false);
  });

  it("accepts a supplied creator attestation verbatim", () => {
    const r = validateRenewalAttestation({ consentedAt: "2026-09-24", declaration: "I renew until 2028." });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.attestation, { consentedAt: "2026-09-24", declaration: "I renew until 2028." });
  });
});

describe("passport source-media binding data", () => {
  it("file rows parse multiple pf:sourceMedia references into ids", () => {
    const row = rowToPassport({
      "@id": "urn:permitframe:passport:pp1",
      "@type": "PermitFramePermissionPassport",
      "pf:creatorId": "c1",
      "pf:creatorName": "Creator",
      "pf:sourceMedia": [{ "@id": "urn:permitframe:media:m1" }, { "@id": "urn:permitframe:media:m2" }],
      "pf:platform": "instagram",
      "pf:country": "GR",
      "pf:allowedTransformation": ["edit"],
      "pf:validFrom": "2026-01-01",
      "pf:validUntil": "2027-01-01",
      "pf:status": "active",
      "pf:attestedAt": "2026-01-01",
      "pf:declaration": "ok",
      "pf:visibility": "public"
    });
    assert.deepEqual(row.sourceMediaIds, ["m1", "m2"]);
  });

  it("file rows with no media references stay empty (fail closed downstream)", () => {
    const row = rowToPassport({
      "@id": "urn:permitframe:passport:pp1",
      "@type": "PermitFramePermissionPassport",
      "pf:creatorId": "c1",
      "pf:creatorName": "Creator",
      "pf:platform": "instagram",
      "pf:country": "GR",
      "pf:allowedTransformation": ["edit"],
      "pf:validFrom": "2026-01-01",
      "pf:validUntil": "2027-01-01",
      "pf:status": "active",
      "pf:attestedAt": "2026-01-01",
      "pf:declaration": "ok",
      "pf:visibility": "public"
    });
    assert.deepEqual(row.sourceMediaIds, []);
    const ev = evidence({ passport: { ...passport("pp_selected"), sourceMediaIds: row.sourceMediaIds } });
    assert.equal(checkAuthorizationBinding(ev).ok, false);
  });

  it("parsed multi-media passports authorize any covered media", () => {
    const row = rowToPassport({
      "@id": "urn:permitframe:passport:pp1",
      "pf:sourceMedia": [{ "@id": "urn:permitframe:media:m1" }, { "@id": "urn:permitframe:media:m2" }]
    });
    const base = evidence({ passport: { ...passport("pp_selected"), sourceMediaIds: row.sourceMediaIds } });
    assert.equal(checkAuthorizationBinding(base).ok, true);
    const second = {
      ...base,
      campaign: { ...base.campaign, sourceMediaId: "m2" },
      media: media({ id: "m2" })
    };
    assert.equal(checkAuthorizationBinding(second).ok, true);
  });
});

describe("renewal consent-request input", () => {
  function oldPassport() {
    return passport("pp_old", {
      creatorId: "c9",
      creatorName: "Old Creator",
      sourceMediaIds: ["m9"],
      platforms: ["tiktok"],
      countries: ["DE"],
      allowedTransformations: ["edit", "animate"],
      validUntil: "2026-09-01",
      status: "active"
    });
  }

  it("prefills a consent request from the old permission without touching it", () => {
    const before = oldPassport();
    const frozen = JSON.parse(JSON.stringify(before)) as typeof before;
    const r = buildRenewalConsentInput(before, "2028-01-01", "2026-09-24");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.input, {
      creatorId: "c9",
      sourceMediaIds: ["m9"],
      platforms: ["tiktok"],
      countries: ["DE"],
      allowedTransformations: ["edit", "animate"],
      validUntil: "2028-01-01",
      purpose: "Renewed permission for Old Creator (replaces permission pp_old)."
    });
    assert.deepEqual(before, frozen);
  });

  it("rejects bad dates and media-less permissions", () => {
    assert.deepEqual(buildRenewalConsentInput(oldPassport(), "09-24", "2026-09-24"), {
      ok: false,
      error: "validUntil must be YYYY-MM-DD"
    });
    assert.deepEqual(buildRenewalConsentInput(oldPassport(), "2026-09-24", "2026-09-24"), {
      ok: false,
      error: "Renewal must extend into the future - pick a date after today."
    });
    assert.deepEqual(buildRenewalConsentInput({ ...oldPassport(), sourceMediaIds: [] }, "2028-01-01", "2026-09-24"), {
      ok: false,
      error: "This permission names no approved media - create a new consent request manually."
    });
  });

  it("caps the generated purpose at the consent limit", () => {
    const r = buildRenewalConsentInput(
      { ...oldPassport(), creatorName: "C".repeat(160), id: "pp_with_a_long_id_123" },
      "2028-01-01",
      "2026-09-24"
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.input.purpose.length <= 140);
    assert.match(r.input.purpose, /replaces permission pp_with_a_long_id_123/);
  });
});

const savedEnv: Record<string, string | undefined> = {};

describe("submit gate blocks on rights change", () => {
  before(() => {
    savedEnv.DKG_MODE = process.env.DKG_MODE;
    process.env.DKG_MODE = "__unsupported_test__";
  });

  after(() => {
    if (savedEnv.DKG_MODE === undefined) delete process.env.DKG_MODE;
    else process.env.DKG_MODE = savedEnv.DKG_MODE;
    setRunStore(null);
  });

  afterEach(() => {
    setRunStore(null);
  });

  function seedDb(revoked: boolean): Database {
    const d = emptyDb();
    d.sourceMedia.push(media());
    d.passports.push(passport("pp_selected", revoked ? { status: "revoked" } : {}));
    d.campaigns.push({
      ...(campaign() as unknown as Record<string, unknown>),
      status: "draft",
      preflight: { decision: "allow", checkedAt: TODAY, blockers: [], allowedClaims: [], promptConstraints: [], plan: [], queriedRights: [], queriedFacts: [], sparqlPreview: "" },
      jobs: [],
      receipts: [],
      comments: [],
      captions: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    } as unknown as Campaign);
    return d;
  }

  it("a campaign allowed earlier is blocked when the passport is revoked before submission", async () => {
    const { store } = memoryStore(seedDb(true));
    setRunStore(store);
    const r = await submitRun({ campaignId: "cmp_authz", workspaceId: "ws1" });
    assert.equal(r.created, false);
    assert.equal(r.run, undefined);
    assert.match(r.error ?? "", /has been revoked/);
    assert.match(r.error ?? "", /pp_selected/);
  });

  it("no provider dispatch occurs after a failed revalidation", async () => {
    const seen: { tool: string; args: Record<string, unknown> }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      const ok = (structured: Record<string, unknown>) => ({
        result: { structuredContent: structured, content: [] },
        jsonrpc: "2.0",
        id: "t"
      });
      const send = (payload: Record<string, unknown>) =>
        new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
      if (body.method === "initialize") return send(ok({ protocolVersion: "2025-03-26" }));
      if (body.method === "notifications/initialized") return send({});
      const tool = String(body.params?.name);
      if (tool === "list_capabilities") {
        return send(ok({ total: 1, capabilities: [{ name: "flux-dev", kind: "ai", availability: "available", model_id: "", description: "" }] }));
      }
      if (tool === "get_pricing") return send(ok({ capabilities: [] }));
      seen.push({ tool, args: (body.params?.arguments ?? {}) as Record<string, unknown> });
      return send(ok({}));
    }) as typeof fetch;
    try {
      const db = seedDb(true);
      const campaign = db.campaigns[0];
      campaign.preflight = {
        decision: "allow",
        checkedAt: TODAY,
        blockers: [],
        allowedClaims: [],
        promptConstraints: [],
        plan: [
          {
            id: "keyframe",
            kind: "text-to-image",
            capability: "flux-dev",
            label: "Keyframe",
            format: "9:16",
            dependsOnStageIds: [],
            inputSource: "approved-source",
            qualityProfile: "balanced",
            role: "conceptImage"
          }
        ],
        queriedRights: [],
        queriedFacts: [],
        sparqlPreview: ""
      };
      campaign.jobs.push({
        id: "job_keyframe",
        campaignId: "cmp_authz",
        stageId: "keyframe",
        kind: "text-to-image",
        capability: "flux-dev",
        requestedCapability: "flux-dev",
        qualityProfile: "balanced",
        role: "conceptImage",
        prompt: "still brief",
        status: "queued",
        startedAt: new Date().toISOString()
      });
      campaign.runs = [
        {
          id: "run_authz",
          campaignId: "cmp_authz",
          stageIds: ["keyframe"],
          status: "active",
          maxConcurrency: 3,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ];
      const { store, read } = memoryStore(db);
      setRunStore(store);
      await pumpRun("ws1", "cmp_authz", { runId: "run_authz", budgetMs: 15000 });
      const job = read().campaigns[0].jobs.find((j) => j.stageId === "keyframe")!;
      assert.equal(job.status, "failed");
      assert.match(job.error ?? "", /has been revoked/);
      assert.deepEqual(
        seen.filter((s) => s.tool === "create_media"),
        [],
        "no provider media call after failed authorization"
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
