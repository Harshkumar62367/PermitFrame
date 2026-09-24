import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * /api/healthz is the hosting liveness probe (Render healthCheckPath): it
 * must stay public (no session check), cheap (no I/O), and dependency-free
 * (no auth, database, DKG, or provider reads). /api/health remains the
 * authenticated integration-status endpoint.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "app", "api", "healthz", "route.ts"), "utf8");

describe("healthz liveness probe", () => {
  it("imports nothing but next/server - no auth, db, DKG, or provider reads", () => {
    assert.match(source, /from "next\/server"/);
    assert.ok(!source.includes("@/server"), "must not import server modules");
    assert.ok(!source.includes("next/headers"), "must not read cookies/headers");
    assert.ok(!source.includes("process.env"), "must not read env");
    assert.ok(!/requireCurrentSession|AuthenticationRequired/.test(source), "must not gate on a session");
  });

  it("answers {ok:true} with no environment configured", async () => {
    for (const key of ["DATABASE_URL", "DKG_SSH_HOST", "PRIVY_APP_SECRET", "NEXT_PUBLIC_PRIVY_APP_ID"]) {
      delete process.env[key];
    }
    const mod = (await import("../app/api/healthz/route")) as unknown as {
      default?: { GET?: () => Response | Promise<Response> };
      GET?: () => Response | Promise<Response>;
    };
    const GET = mod.GET ?? mod.default?.GET;
    assert.equal(typeof GET, "function");
    const res = await (GET as () => Response | Promise<Response>)();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});
