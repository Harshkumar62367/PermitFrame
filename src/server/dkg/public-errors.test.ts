import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  containsOperationalDetail,
  isSafePublicDomainError,
  maskOperationalDetail,
  sanitizeDkgError,
  scrubStoredText,
  LEDGER_UNAVAILABLE,
  PERMISSION_CHECK_UNAVAILABLE,
  PROOF_RECORDING_UNAVAILABLE,
  PROOF_SERVICE_ERROR
} from "./public-errors";
import { redactSecrets } from "./edge-node-adapter";

/**
 * DKG error disclosure boundary. No network, no DKG, no paid calls — the
 * SSH failure below mirrors the exact shape rendered in the UI screenshot
 * (dkg CLI scp transport failure with key path, temp files, user, and IP).
 */

// Exact failure shape from the production incident: raw transport text that
// reached the variants banner. Synthetic temp names — no live secrets.
const SCREENSHOT_SSH_FAILURE =
  "dkg CLI failed (query 0x31c83Ac625c29Ef7F4fabDB49ee68Fb56B06977c/permitframe-acceptance-20260919): " +
  "Command failed: scp -i C:\\Users\\harsh\\.ssh\\id_ed25519_dkg_ec2 -o BatchMode=yes -o ConnectTimeout=15 " +
  "-o StrictHostKeyChecking=accept-new C:\\Users\\harsh\\AppData\\Local\\Temp\\pf-sq-cSLWcY\\query.sparql " +
  "harsh@52.58.167.195:/tmp/pf-r-20376-0-query.sparql ssh: connect to host 52.58.167.195 port 22: Connectio";

const FORBIDDEN_TOKENS = [
  "harsh",
  "C:\\Users",
  ".ssh",
  "id_ed25519",
  "scp",
  "ssh",
  "52.58.167.195",
  "/tmp/",
  "query.sparql",
  "pf-sq-",
  "BatchMode",
  "StrictHostKeyChecking",
  "0x31c83Ac625c29Ef7F4fabDB49ee68Fb56B06977c",
  "permitframe-acceptance",
  "Command failed",
  "port 22"
];

function assertUiSafe(response: { code: string; message: string }) {
  const combined = `${response.code} ${response.message}`;
  for (const token of FORBIDDEN_TOKENS) {
    assert.ok(!combined.includes(token), `UI-safe response must not contain "${token}"`);
  }
}

describe("sanitizeDkgError", () => {
  it("maps the screenshot SSH failure to a safe preflight message + stable code", () => {
    const safe = sanitizeDkgError(new Error(SCREENSHOT_SSH_FAILURE), "preflight");
    assert.equal(safe.code, PERMISSION_CHECK_UNAVAILABLE.code);
    assert.equal(safe.message, PERMISSION_CHECK_UNAVAILABLE.message);
    assert.equal(safe.status, 503);
    assert.equal(safe.retryable, true);
    assertUiSafe(safe);
  });

  it("maps the same failure per context without leaking in any of them", () => {
    const query = sanitizeDkgError(new Error(SCREENSHOT_SSH_FAILURE), "query");
    assert.equal(query.code, LEDGER_UNAVAILABLE.code);
    assert.equal(query.message, LEDGER_UNAVAILABLE.message);
    assertUiSafe(query);
    const approve = sanitizeDkgError(new Error(SCREENSHOT_SSH_FAILURE), "approve");
    assert.equal(approve.code, PROOF_RECORDING_UNAVAILABLE.code);
    assert.equal(approve.message, PROOF_RECORDING_UNAVAILABLE.message);
    assertUiSafe(approve);
    const publish = sanitizeDkgError(new Error(SCREENSHOT_SSH_FAILURE), "publish");
    assert.equal(publish.code, PROOF_RECORDING_UNAVAILABLE.code);
    assertUiSafe(publish);
  });

  it("maps unreachable signatures without operational detail to the safe message", () => {
    const safe = sanitizeDkgError(new Error("fetch failed"), "mutation");
    assert.equal(safe.code, LEDGER_UNAVAILABLE.code);
    assert.equal(safe.status, 503);
    assertUiSafe(safe);
  });

  it("maps unknown engine failures to the generic proof-service message", () => {
    const safe = sanitizeDkgError(new TypeError("Cannot read properties of undefined (reading 'rows')"), "query");
    assert.equal(safe.code, PROOF_SERVICE_ERROR.code);
    assert.equal(safe.message, PROOF_SERVICE_ERROR.message);
    assert.equal(safe.status, 500);
    assertUiSafe(safe);
  });

  it("maps opaque blobs and empty failures to the generic message", () => {
    const blob = sanitizeDkgError(new Error('{"code": -32000, "data": "0xdeadbeef"}'), "query");
    assert.equal(blob.code, PROOF_SERVICE_ERROR.code);
    const empty = sanitizeDkgError(new Error("   "), "query");
    assert.equal(empty.message, PROOF_SERVICE_ERROR.message);
  });

  it("preserves precise validation and policy-blocker text (no over-sanitizing)", () => {
    const blockers = [
      "Blocked campaigns cannot be approved",
      "platforms array is required",
      "Consent already attested",
      "Passport not found",
      "Resolve the rights block before choosing a production template - blocked campaigns never reach generation."
    ];
    for (const text of blockers) {
      const safe = sanitizeDkgError(new Error(text), "preflight");
      assert.equal(safe.message, text);
      assert.equal(safe.code, "request_failed");
    }
  });

  it("denies unfamiliar short errors by default: relay failure returns generic text, not itself", () => {
    const raw = "relay negotiation failed through broker alpha";
    const safe = sanitizeDkgError(new Error(raw), "query");
    assert.equal(safe.code, PROOF_SERVICE_ERROR.code);
    assert.equal(safe.message, PROOF_SERVICE_ERROR.message);
    assert.ok(!`${safe.code} ${safe.message}`.includes("alpha"));
    assert.ok(!`${safe.code} ${safe.message}`.includes("broker"));
    assert.ok(!`${safe.code} ${safe.message}`.includes("relay"));
  });

  it("denies new-style provider errors carrying a domain/URL with no current pattern match", () => {
    const raw = "upstream render farm https://renders.example.com/v2/jobs returned status unavailable";
    const safe = sanitizeDkgError(new Error(raw), "query");
    assert.equal(safe.code, PROOF_SERVICE_ERROR.code);
    assert.equal(safe.message, PROOF_SERVICE_ERROR.message);
    const combined = `${safe.code} ${safe.message}`;
    assert.ok(!combined.includes("renders.example.com"));
    assert.ok(!combined.includes("upstream"));
    assert.ok(!combined.includes(raw));
  });

  it("denies short unknown text in every context and exposes none of it", () => {
    const raw = "quorum drift detected on shard seven";
    for (const context of ["query", "preflight", "publish", "approve", "mutation"] as const) {
      const safe = sanitizeDkgError(new Error(raw), context);
      assert.ok(!`${safe.code} ${safe.message}`.includes("quorum"));
      assert.ok(!`${safe.code} ${safe.message}`.includes("shard"));
      assert.ok(!`${safe.code} ${safe.message}`.includes(raw));
    }
  });
});

describe("isSafePublicDomainError", () => {
  it("allows the known inventory: blockers, validation, domain, and gate messages", () => {
    const allowed = [
      "Blocked campaigns cannot be approved",
      "Blocked: super granular policy verdict with reasons",
      "Campaign not found",
      "Passport not found",
      "Consent already attested",
      "Only the workspace owner may delete or archive campaigns.",
      "Creator name is required.",
      "platforms array is required",
      "text is required",
      "query is required",
      "Preflight has not approved this campaign",
      "Produce the campaign pack before approving - previews and unsaved outputs cannot be signed off yet",
      "Archived campaigns are read-only - “Summer launch” cannot be approved. It is kept for audit history."
    ];
    for (const text of allowed) {
      assert.equal(isSafePublicDomainError(text, "preflight"), true, text);
    }
  });

  it("denies everything else, including clean-looking unknown text", () => {
    const denied = [
      "relay negotiation failed through broker alpha",
      "kaboom",
      "upstream render farm https://renders.example.com/v2/jobs returned status unavailable",
      "Cannot read properties of undefined (reading 'rows')",
      '{"code": -32000}',
      "",
      "x".repeat(401)
    ];
    for (const text of denied) {
      assert.equal(isSafePublicDomainError(text, "query"), false, text);
    }
  });

  it("vetoes allowlisted shapes the moment operational detail appears", () => {
    assert.equal(isSafePublicDomainError("Blocked 10.0.0.5 via ssh", "preflight"), false);
    assert.equal(
      isSafePublicDomainError("Archived campaigns are read-only - scp -i C:\\k\\id_ed25519 x", "approve"),
      false
    );
  });
});

describe("containsOperationalDetail", () => {
  it("detects transport, path, identity, and query artefacts", () => {
    assert.equal(containsOperationalDetail(SCREENSHOT_SSH_FAILURE), true);
    assert.equal(containsOperationalDetail("ssh: connect to host 10.0.0.5 port 22"), true);
    assert.equal(containsOperationalDetail("ENOENT: no such file /tmp/pf-ka-x/y.ttl"), true);
    assert.equal(containsOperationalDetail("did:dkg:base:84532/0xabc/1"), true);
  });

  it("leaves ordinary domain and provider-status text alone", () => {
    assert.equal(containsOperationalDetail("Blocked campaigns cannot be approved"), false);
    assert.equal(containsOperationalDetail("Livepeer job ended (completed) without an output."), false);
    assert.equal(containsOperationalDetail("Quoted from live Creative MCP prices"), false);
  });

  it("does not treat URL schemes as Windows paths", () => {
    assert.equal(containsOperationalDetail("upstream https://renders.example.com/v2/jobs unavailable"), false);
    assert.equal(
      maskOperationalDetail("fetch https://renders.example.com/v2/jobs failed"),
      "fetch https://renders.example.com/v2/jobs failed"
    );
  });
});

describe("maskOperationalDetail", () => {
  it("masks hosts, identities, paths, and addresses but keeps prose", () => {
    const masked = maskOperationalDetail(
      "connect to host 52.58.167.195 as harsh@52.58.167.195 key C:\\Users\\harsh\\.ssh\\id_ed25519_dkg_ec2 graph 0x31c83Ac625c29Ef7F4fabDB49ee68Fb56B06977c/x"
    );
    assert.ok(!masked.includes("52.58.167.195"));
    assert.ok(!masked.includes("harsh@"));
    assert.ok(!masked.includes("C:\\Users"));
    assert.ok(!masked.includes("0x31c83Ac625c29Ef7F4fabDB49ee68Fb56B06977c"));
    assert.ok(masked.includes("[host]") && masked.includes("[path]"));
  });

  it("leaves ordinary provider and validation text byte-identical", () => {
    const clean = "Livepeer refused this stage: rate limited, retry shortly.";
    assert.equal(maskOperationalDetail(clean), clean);
  });
});

describe("scrubStoredText", () => {
  it("replaces tainted legacy records with the fallback", () => {
    assert.equal(
      scrubStoredText(`old failure: ${SCREENSHOT_SSH_FAILURE}`, "Withheld."),
      "Withheld."
    );
  });

  it("passes clean history through untouched", () => {
    assert.equal(scrubStoredText("Derivative receipt rcpt_1 published.", "Withheld."), "Derivative receipt rcpt_1 published.");
    assert.equal(scrubStoredText("", "Withheld."), "");
  });
});

describe("log redaction", () => {
  it("strips inline private keys and JWT session tokens", () => {
    const pem = "key -----BEGIN OPENSSH PRIVATE KEY-----\nbG9seatXT0\n-----END OPENSSH PRIVATE KEY----- tail";
    assert.ok(!redactSecrets(pem).includes("bG9seatXT0"));
    const jwt = "session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c done";
    const clean = redactSecrets(jwt);
    assert.ok(!clean.includes("eyJhbGciOiJIUzI1NiJ9"));
    assert.ok(clean.includes("[redacted-jwt]"));
  });
});
