import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Docker build contract: Next.js inlines NEXT_PUBLIC_* at compile time, so
 * the build stage receives ONLY the public Privy app id as a build arg.
 * Every sensitive value (PRIVY_APP_SECRET, database URLs, DKG SSH key,
 * Cloudinary credentials, ...) stays runtime-only and must never gain an
 * ARG/ENV in the image build.
 */
const here = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(join(here, "..", "..", "Dockerfile"), "utf8");
const lines = dockerfile.split(/\r?\n/);

function stageOf(index: number): string {
  let stage = "";
  for (let i = 0; i <= index; i++) {
    const m = lines[i].match(/^FROM\s+\S+\s+AS\s+(\S+)/i);
    if (m) stage = m[1].toLowerCase();
  }
  return stage;
}

const argNames = lines
  .map((line, i) => ({ line, i }))
  .filter(({ line }) => /^\s*ARG\s+/i.test(line))
  .map(({ line, i }) => ({ name: line.replace(/^\s*ARG\s+/i, "").split(/[=\s]/)[0], stage: stageOf(i) }));

describe("Dockerfile build contract", () => {
  it("declares only NEXT_PUBLIC_PRIVY_APP_ID as a Privy build argument", () => {
    const privyArgs = argNames.filter((a) => /privy/i.test(a.name));
    assert.deepEqual(privyArgs.map((a) => a.name), ["NEXT_PUBLIC_PRIVY_APP_ID"]);
    assert.equal(privyArgs[0].stage, "build");
  });

  it("declares no secret-shaped variable as ARG", () => {
    const secretArgs = argNames.filter((a) =>
      /SECRET|DATABASE_URL|DKG_SSH_KEY|CLOUDINARY|LIVEPEER_MCP_BEARER|PRIVATE|TOKEN|PASSWORD/i.test(a.name)
    );
    assert.deepEqual(secretArgs, []);
  });

  it("exposes the public app id to compilation in the build stage only", () => {
    const envLines = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /^\s*ENV\s+NEXT_PUBLIC_PRIVY_APP_ID=/i.test(line));
    assert.equal(envLines.length, 1);
    assert.equal(stageOf(envLines[0].i), "build");
    assert.match(envLines[0].line, /\$NEXT_PUBLIC_PRIVY_APP_ID/);
  });
});
