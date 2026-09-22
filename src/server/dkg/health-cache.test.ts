import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getIntegrationHealth,
  resetIntegrationHealthForTests,
  settleIntegrationHealth,
  type HealthProbes
} from "./health-cache";
import type { DkgHealth } from "./adapter";

const OK_DKG: DkgHealth = {
  mode: "edge-node",
  healthy: true,
  endpoint: "local daemon (127.0.0.1:9200)",
  detail: "Edge Node running - 3 peer(s)."
};

function okProbes(): HealthProbes {
  return {
    dkg: async () => OK_DKG,
    livepeer: async () => ({ endpoint: "https://agent.livepeer.org/api/mcp/raw", keyless: true, reachable: true, detail: "ok" })
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("getIntegrationHealth", () => {
  beforeEach(() => resetIntegrationHealthForTests());

  it("answers instantly with checking while a slow probe runs; slowness never reads as offline", async () => {
    // Simulates `dkg status` taking ~4s (past the old 3s timeout): the route
    // must return in milliseconds with "checking", not degraded/unavailable.
    let dkgCalls = 0;
    const probes: HealthProbes = {
      dkg: async () => {
        dkgCalls += 1;
        await delay(4000);
        return OK_DKG;
      },
      livepeer: okProbes().livepeer
    };
    const started = Date.now();
    const first = await getIntegrationHealth(probes);
    assert.ok(Date.now() - started < 1000, "first answer must be instant, not probe-bound");
    assert.equal(first.dkg.state, "checking");
    assert.equal(first.dkg.checkedAt, null);
    assert.notEqual(first.dkg.state, "degraded");
    assert.notEqual(first.dkg.state, "unavailable");
    // While the probe is still running, every answer stays "checking".
    const during = await getIntegrationHealth(probes);
    assert.equal(during.dkg.state, "checking");
    assert.equal(dkgCalls, 1);
    // Once the slow probe settles, the ledger is healthy - proven by the
    // completed check, not assumed.
    await settleIntegrationHealth();
    const after = await getIntegrationHealth(probes);
    assert.equal(after.dkg.state, "healthy");
    assert.equal(after.dkg.healthy, true);
    assert.ok(after.dkg.checkedAt);
    assert.equal(after.dkg.stale, false);
  });

  it("does not re-run probes on every call (no CLI per navigation)", async () => {
    let dkgCalls = 0;
    let livepeerCalls = 0;
    const probes: HealthProbes = {
      dkg: async () => {
        dkgCalls += 1;
        return OK_DKG;
      },
      livepeer: async () => {
        livepeerCalls += 1;
        return { endpoint: "e", keyless: true, reachable: true, detail: "ok" };
      }
    };
    await getIntegrationHealth(probes);
    await settleIntegrationHealth();
    await getIntegrationHealth(probes);
    await getIntegrationHealth(probes);
    assert.equal(dkgCalls, 1);
    assert.equal(livepeerCalls, 1);
  });

  it("a probe that always fails is unavailable, never healthy", async () => {
    const probes: HealthProbes = {
      dkg: async () => ({ ...OK_DKG, healthy: false, detail: "Edge Node unreachable - run \"dkg start\"." }),
      livepeer: async () => {
        throw new Error("connection refused");
      }
    };
    const first = await getIntegrationHealth(probes);
    assert.equal(first.dkg.state, "checking");
    await settleIntegrationHealth();
    const after = await getIntegrationHealth(probes);
    assert.equal(after.dkg.state, "unavailable");
    assert.equal(after.dkg.healthy, false);
    assert.ok(after.dkg.detail.includes("dkg start"));
    assert.equal(after.livepeer.state, "unavailable");
    assert.equal(after.livepeer.reachable, false);
  });

  it("failure after a success is degraded and keeps serving the last good result", async () => {
    let fail = false;
    const probes: HealthProbes = {
      dkg: async () => (fail ? { ...OK_DKG, healthy: false, detail: "timed out" } : OK_DKG),
      livepeer: okProbes().livepeer
    };
    const config = { healthyTtlMs: 50 };
    await getIntegrationHealth(probes, config);
    await settleIntegrationHealth();
    const healthy = await getIntegrationHealth(probes, config);
    assert.equal(healthy.dkg.state, "healthy");
    // Expire the healthy entry, then fail the revalidation: the answer must
    // stay on the last good result (marked stale) and settle to degraded -
    // a transient failure never reads as "never known".
    await delay(70);
    fail = true;
    const stale = await getIntegrationHealth(probes, config);
    assert.equal(stale.dkg.state, "healthy");
    assert.equal(stale.dkg.stale, true);
    assert.equal(stale.dkg.healthy, true);
    await settleIntegrationHealth();
    const degraded = await getIntegrationHealth(probes, config);
    assert.equal(degraded.dkg.state, "degraded");
    assert.equal(degraded.dkg.healthy, false);
    assert.ok(degraded.dkg.detail.includes("timed out"));
  });
});
