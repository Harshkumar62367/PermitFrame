import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadLocalEnvFile, parseEnvLine } from "../../scripts/with-local-env.mjs";

/**
 * Practical coverage for the db-script env wrapper: .env.local stays a
 * local-dev convenience (fills gaps, never overrides), and an absent file
 * is a no-op so Render-shell environments work on dashboard variables
 * alone. No secrets are asserted on - only key names and sentinel values.
 */
const here = dirname(fileURLToPath(import.meta.url));
const wrapper = join(here, "..", "..", "scripts", "with-local-env.mjs");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pf-env-"));
}

describe("parseEnvLine", () => {
  it("parses KEY=value, export prefix, and quoted values", () => {
    assert.deepEqual(parseEnvLine("DATABASE_URL=postgres://x"), { key: "DATABASE_URL", value: "postgres://x" });
    assert.deepEqual(parseEnvLine("export FOO=bar"), { key: "FOO", value: "bar" });
    assert.deepEqual(parseEnvLine('QUOTED="a b"'), { key: "QUOTED", value: "a b" });
    assert.deepEqual(parseEnvLine("SINGLE='c d'"), { key: "SINGLE", value: "c d" });
    assert.deepEqual(parseEnvLine("EMPTY="), { key: "EMPTY", value: "" });
  });

  it("ignores blanks, comments, and malformed lines", () => {
    assert.equal(parseEnvLine(""), null);
    assert.equal(parseEnvLine("   "), null);
    assert.equal(parseEnvLine("# comment"), null);
    assert.equal(parseEnvLine("no-equals-here"), null);
    assert.equal(parseEnvLine("1BAD=oops"), null);
  });
});

describe("loadLocalEnvFile", () => {
  it("is a no-op when the file is absent", () => {
    assert.deepEqual(loadLocalEnvFile(tempDir()), []);
  });

  it("fills gaps from the file but never overrides the environment", () => {
    const dir = tempDir();
    const fromFile = `PF_WRAPPER_FILE_${Date.now()}`;
    const contested = `PF_WRAPPER_CONTESTED_${Date.now()}`;
    try {
      writeFileSync(join(dir, ".env.local"), [`${fromFile}=file-value`, `${contested}=file-value`, "# comment", ""].join("\n"));
      process.env[contested] = "env-value";
      const added = loadLocalEnvFile(dir);
      assert.deepEqual(added, [fromFile]);
      assert.equal(process.env[fromFile], "file-value");
      assert.equal(process.env[contested], "env-value");
    } finally {
      delete process.env[fromFile];
      delete process.env[contested];
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("with-local-env CLI", () => {
  it("runs the child on ambient env when no .env.local applies, propagating exit codes", () => {
    const dir = tempDir();
    const sentinel = `PF_WRAPPER_CLI_${Date.now()}`;
    try {
      writeFileSync(join(dir, "probe.mjs"), `console.log(process.env.${sentinel} ?? "missing");process.exit(41);`);
      const run = spawnSync(process.execPath, [wrapper, join(dir, "probe.mjs")], {
        encoding: "utf8",
        env: { ...process.env, [sentinel]: "env-only" }
      });
      assert.equal(run.stdout.trim(), "env-only");
      assert.equal(run.status, 41);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
