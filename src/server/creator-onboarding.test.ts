import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveMediaCreator, validateCreatorInput } from "./platform";
import { isSafePublicDomainError, sanitizeDkgError } from "./dkg/public-errors";
import type { Database } from "./types";
import { emptyDb } from "./store";

/**
 * Creator onboarding: a fresh workspace (creators: []) can add a creator,
 * and media registration never silently picks the first creator when the
 * user did not explicitly select one.
 */
function dbWithCreators(ids: string[]): Database {
  const db = emptyDb();
  db.creators = ids.map((id, i) => ({ id, name: `Creator ${i}`, handle: `@c${i}` }));
  return db;
}

describe("validateCreatorInput", () => {
  it("accepts a name with an optional handle", () => {
    assert.deepEqual(validateCreatorInput({ name: "Maya Chen", handle: "@maya" }), {
      ok: true,
      value: { name: "Maya Chen", handle: "@maya" }
    });
  });

  it("accepts a name alone and trims whitespace", () => {
    assert.deepEqual(validateCreatorInput({ name: "  Maya  " }), {
      ok: true,
      value: { name: "Maya", handle: "" }
    });
  });

  it("rejects a missing name with an actionable message", () => {
    assert.deepEqual(validateCreatorInput({}), {
      ok: false,
      error: "Give the creator a name so media and requests can attach to them."
    });
    assert.deepEqual(validateCreatorInput({ name: "   ", handle: "@x" }), {
      ok: false,
      error: "Give the creator a name so media and requests can attach to them."
    });
  });

  it("rejects an overlong name", () => {
    assert.deepEqual(validateCreatorInput({ name: "M".repeat(81) }), {
      ok: false,
      error: "Creator name must be 80 characters or fewer."
    });
  });

  it("rejects an unsafe handle", () => {
    assert.deepEqual(validateCreatorInput({ name: "Maya", handle: "not a handle!" }), {
      ok: false,
      error: "Handle may only contain letters, numbers, and @ _ . - (40 characters or fewer)."
    });
    assert.deepEqual(validateCreatorInput({ name: "Maya", handle: `@${"h".repeat(41)}` }), {
      ok: false,
      error: "Handle may only contain letters, numbers, and @ _ . - (40 characters or fewer)."
    });
  });
});

describe("resolveMediaCreator (no silent first-creator fallback)", () => {
  it("fails closed on a missing id even when creators exist", () => {
    for (const missing of [undefined, "", null, 42]) {
      const r = resolveMediaCreator(dbWithCreators(["crt_a", "crt_b"]), missing);
      assert.deepEqual(r, {
        ok: false,
        error: "Choose a creator for this asset - add one in the Media library first."
      });
    }
  });

  it("fails on an empty workspace instead of inventing a creator", () => {
    assert.deepEqual(resolveMediaCreator(emptyDb(), ""), {
      ok: false,
      error: "Choose a creator for this asset - add one in the Media library first."
    });
  });

  it("rejects an unknown creator id", () => {
    assert.deepEqual(resolveMediaCreator(dbWithCreators(["crt_a"]), "crt_ghost"), {
      ok: false,
      error: "The chosen creator no longer exists - pick another one."
    });
  });

  it("resolves the explicitly chosen creator (never just the first row)", () => {
    const r = resolveMediaCreator(dbWithCreators(["crt_a", "crt_b"]), "crt_b");
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.id, "crt_b");
  });
});

describe("creator onboarding errors stay user-visible", () => {
  const messages = [
    "Give the creator a name so media and requests can attach to them.",
    "Creator name must be 80 characters or fewer.",
    "Handle may only contain letters, numbers, and @ _ . - (40 characters or fewer).",
    "Choose a creator for this asset - add one in the Media library first.",
    "The chosen creator no longer exists - pick another one."
  ];
  for (const message of messages) {
    it(`passes the sanitizer allowlist: ${message.slice(0, 40)}…`, () => {
      assert.equal(isSafePublicDomainError(message, "workspace"), true);
      const safe = sanitizeDkgError(new Error(message), "workspace");
      assert.equal(safe.message, message);
      assert.equal(safe.status, 400);
    });
  }
});
