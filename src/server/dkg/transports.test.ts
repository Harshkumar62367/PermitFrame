import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTransportFromEnv,
  extractFileUploads,
  loadSshConfigFromEnv,
  LocalCliTransport,
  shellEscape,
  SshCliTransport
} from "./transports";

describe("loadSshConfigFromEnv", () => {
  it("returns null when no host is configured (local transport)", () => {
    assert.equal(loadSshConfigFromEnv({}), null);
    assert.equal(loadSshConfigFromEnv({ DKG_SSH_HOST: "  " }), null);
  });

  it("applies defaults and trims values", () => {
    const cfg = loadSshConfigFromEnv({ DKG_SSH_HOST: "  52.58.167.195 " });
    assert.ok(cfg);
    assert.equal(cfg.host, "52.58.167.195");
    assert.equal(cfg.user, "harsh");
    assert.equal(cfg.remoteBin, "/home/harsh/.local/bin/dkg");
    assert.equal(cfg.connectTimeoutSecs, 15);
    assert.ok(cfg.keyFile.endsWith("id_ed25519_dkg_ec2"));
    assert.equal(cfg.keyInline, undefined);
  });

  it("honours explicit user, key and timeout overrides", () => {
    const cfg = loadSshConfigFromEnv({
      DKG_SSH_HOST: "h",
      DKG_SSH_USER: "u",
      DKG_SSH_KEY: "/tmp/k",
      DKG_SSH_KEY_INLINE: "inline",
      DKG_REMOTE_DKG_BIN: "/x/dkg",
      DKG_SSH_CONNECT_TIMEOUT_SECS: "7"
    });
    assert.ok(cfg);
    assert.equal(cfg.user, "u");
    assert.equal(cfg.keyFile, "/tmp/k");
    assert.equal(cfg.keyInline, "inline");
    assert.equal(cfg.remoteBin, "/x/dkg");
    assert.equal(cfg.connectTimeoutSecs, 7);
  });

  it("selects the SSH transport only when a host is set", () => {
    assert.ok(createTransportFromEnv({}) instanceof LocalCliTransport);
    const ssh = createTransportFromEnv({
      DKG_SSH_HOST: "h",
      DKG_SSH_KEY: __filename // any existing file satisfies the key check
    });
    assert.ok(ssh instanceof SshCliTransport);
  });
});

describe("shellEscape", () => {
  it("passes safe tokens through untouched", () => {
    assert.equal(shellEscape("status"), "status");
    assert.equal(
      shellEscape("0x31c83Ac625c29Ef7F4fabDB49ee68Fb56B06977c/permitframe-acceptance-20260919"),
      "0x31c83Ac625c29Ef7F4fabDB49ee68Fb56B06977c/permitframe-acceptance-20260919"
    );
  });

  it("single-quotes tokens with spaces or metacharacters", () => {
    assert.equal(shellEscape("a b"), "'a b'");
    assert.equal(shellEscape("a$b"), "'a$b'");
    assert.equal(shellEscape("it's"), `'it'\\''s'`);
  });
});

describe("extractFileUploads", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pf-t-"));
  const local = path.join(dir, "q.sparql");
  writeFileSync(local, "SELECT * WHERE { ?s ?p ?o }", "utf8");
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("rewrites --file/--input-file to deterministic remote paths", () => {
    const { remoteArgs, uploads } = extractFileUploads(
      ["query", "cg", "--include-shared-memory", "--file", local],
      (base, i) => `/tmp/t-${i}-${base}`
    );
    assert.deepEqual(remoteArgs, ["query", "cg", "--include-shared-memory", "--file", "/tmp/t-0-q.sparql"]);
    assert.deepEqual(uploads, [{ local, remote: "/tmp/t-0-q.sparql" }]);
  });

  it("leaves missing paths and ordinary args alone", () => {
    const args = ["status", "--file", path.join(dir, "nope.rq"), "ka", "create", "name"];
    const { remoteArgs, uploads } = extractFileUploads(args);
    assert.deepEqual(remoteArgs, args);
    assert.deepEqual(uploads, []);
  });
});
