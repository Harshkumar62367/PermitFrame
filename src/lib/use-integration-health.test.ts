import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HEALTH_SLOW_COPY,
  HEALTH_SLOW_MS,
  createHealthPoller,
  integrationHealthPending,
  type IntegrationHealth
} from "./use-integration-health";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const checking = (overrides?: Partial<IntegrationHealth>): IntegrationHealth => ({
  dkg: { mode: "edge-node", healthy: false, state: "checking" },
  livepeer: { keyless: true, reachable: false, state: "checking" },
  ...overrides
});

const settled: IntegrationHealth = {
  dkg: { mode: "edge-node", healthy: true, state: "healthy" },
  livepeer: { keyless: true, reachable: true, state: "healthy" }
};

describe("integration health polling gate", () => {
  it("polls before a health snapshot exists and while either server probe is checking", () => {
    assert.equal(integrationHealthPending(null), true);
    assert.equal(integrationHealthPending({ ...settled, dkg: { ...settled.dkg, state: "checking" } }), true);
    assert.equal(integrationHealthPending({ ...settled, livepeer: { ...settled.livepeer, state: "checking" } }), true);
  });

  it("stops polling once both probes settle, including unavailable states", () => {
    assert.equal(integrationHealthPending(settled), false);
    assert.equal(
      integrationHealthPending({
        dkg: { mode: "edge-node", healthy: false, state: "unavailable" },
        livepeer: { keyless: true, reachable: false, state: "degraded" }
      }),
      false
    );
  });
});

describe("integration health slow-check", () => {
  it("uses a 20-second client-only threshold with neutral copy", () => {
    assert.equal(HEALTH_SLOW_MS, 20_000);
    assert.equal(HEALTH_SLOW_COPY, "Service status is taking longer than expected. Refresh once or retry.");
  });

  it("polls while either service is checking", async () => {
    let calls = 0;
    const updates: { slow: boolean }[] = [];
    const poller = createHealthPoller({
      read: async () => {
        calls += 1;
        return checking();
      },
      onUpdate: (_health, slow) => {
        updates.push({ slow });
      },
      pollMs: 5,
      slowMs: 1_000
    });
    await tick(40);
    poller.stop();
    assert.ok(calls >= 2, `expected repeated reads while checking, saw ${calls}`);
  });

  it("stops polling once both settle", async () => {
    let calls = 0;
    const poller = createHealthPoller({
      read: async () => {
        calls += 1;
        return settled;
      },
      onUpdate: () => undefined,
      pollMs: 5,
      slowMs: 1_000
    });
    await tick(30);
    poller.stop();
    assert.equal(calls, 1);
  });

  it("becomes slow after the threshold without marking services offline", async () => {
    const seen: { health: IntegrationHealth | null; slow: boolean }[] = [];
    const poller = createHealthPoller({
      read: async () => checking(),
      onUpdate: (health, slow) => {
        seen.push({ health, slow });
      },
      pollMs: 5,
      slowMs: 10
    });
    await tick(40);
    poller.stop();
    const last = seen[seen.length - 1];
    assert.ok(last, "expected at least one update");
    assert.equal(last.slow, true);
    assert.equal(last.health?.dkg.state, "checking");
    assert.equal(last.health?.livepeer.state, "checking");
  });

  it("retry schedules an immediate new fetch", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = () => new Promise<void>((resolve) => { release = resolve; });
    let gateOpen = true;
    const poller = createHealthPoller({
      read: async () => {
        calls += 1;
        if (!gateOpen) await gate();
        return checking();
      },
      onUpdate: () => undefined,
      pollMs: 5_000,
      slowMs: 60_000
    });
    await tick(10);
    assert.equal(calls, 1);
    // Hold the retry read until we assert it started immediately.
    gateOpen = false;
    poller.retry();
    await tick(10);
    assert.equal(calls, 2);
    gateOpen = true;
    release();
    poller.stop();
  });

  it("a settled later response clears slow state", async () => {
    let payload: IntegrationHealth = checking();
    const seen: { health: IntegrationHealth | null; slow: boolean }[] = [];
    const poller = createHealthPoller({
      read: async () => payload,
      onUpdate: (health, slow) => {
        seen.push({ health, slow });
      },
      pollMs: 5,
      slowMs: 10
    });
    await tick(30);
    assert.ok(seen.some((u) => u.slow), "expected slow to fire while checking");
    payload = settled;
    await tick(30);
    poller.stop();
    const last = seen[seen.length - 1];
    assert.ok(last, "expected updates");
    assert.equal(last.slow, false);
    assert.equal(last.health?.dkg.state, "healthy");
    assert.equal(last.health?.livepeer.state, "healthy");
  });

  it("unavailable/degraded responses settle as their real states, never slow", async () => {
    let calls = 0;
    const seen: { health: IntegrationHealth | null; slow: boolean }[] = [];
    const real: IntegrationHealth = {
      dkg: { mode: "edge-node", healthy: false, state: "unavailable" },
      livepeer: { keyless: true, reachable: false, state: "degraded" }
    };
    const poller = createHealthPoller({
      read: async () => {
        calls += 1;
        return real;
      },
      onUpdate: (health, slow) => {
        seen.push({ health, slow });
      },
      pollMs: 5,
      slowMs: 10
    });
    await tick(40);
    poller.stop();
    assert.equal(calls, 1);
    assert.equal(seen[seen.length - 1]?.slow, false);
    assert.equal(seen[seen.length - 1]?.health?.dkg.state, "unavailable");
    assert.equal(seen[seen.length - 1]?.health?.livepeer.state, "degraded");
  });
});

describe("integration health single-flight", () => {
  /** Manually-resolved reads with live concurrency tracking. */
  function manualReads() {
    const resolvers: ((value: IntegrationHealth) => void)[] = [];
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const read = () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<IntegrationHealth>((resolve) => {
        resolvers.push((value) => {
          active -= 1;
          resolve(value);
        });
      });
    };
    return { resolvers, read, calls: () => calls, maxActive: () => maxActive };
  }

  it("retry during an in-flight read queues exactly one immediate follow-up", async () => {
    const manual = manualReads();
    const poller = createHealthPoller({ read: manual.read, onUpdate: () => undefined, pollMs: 5_000, slowMs: 60_000 });
    await tick(10);
    assert.equal(manual.calls(), 1);
    poller.retry();
    await tick(10);
    // Still one active read: no parallel request started.
    assert.equal(manual.calls(), 1);
    assert.equal(manual.maxActive(), 1);
    manual.resolvers[0](checking());
    await tick(20);
    // Exactly one immediate follow-up read, not a 5s poll wait.
    assert.equal(manual.calls(), 2);
    manual.resolvers[1](settled);
    await tick(20);
    poller.stop();
    assert.equal(manual.calls(), 2);
  });

  it("a delayed checking response never overwrites a newer settled response", async () => {
    const manual = manualReads();
    const emitted: (string | undefined)[] = [];
    const poller = createHealthPoller({
      read: manual.read,
      onUpdate: (health) => {
        emitted.push(health?.dkg.state);
      },
      pollMs: 5_000,
      slowMs: 60_000
    });
    await tick(10);
    poller.retry();
    await tick(10);
    manual.resolvers[0](checking());
    await tick(20);
    assert.equal(manual.calls(), 2);
    manual.resolvers[1](settled);
    await tick(20);
    poller.stop();
    assert.equal(manual.maxActive(), 1);
    // Newest emission is the settled state; no stale checking lands after it.
    assert.equal(emitted[emitted.length - 1], "healthy");
    const settledAt = emitted.lastIndexOf("healthy");
    assert.ok(emitted.slice(settledAt + 1).every((s) => s !== "checking"));
  });

  it("multiple retries in flight collapse into one follow-up read", async () => {
    const manual = manualReads();
    const poller = createHealthPoller({ read: manual.read, onUpdate: () => undefined, pollMs: 5_000, slowMs: 60_000 });
    await tick(10);
    poller.retry();
    poller.retry();
    poller.retry();
    await tick(10);
    assert.equal(manual.calls(), 1);
    manual.resolvers[0](checking());
    await tick(20);
    assert.equal(manual.calls(), 2);
    manual.resolvers[1](settled);
    await tick(20);
    poller.stop();
    assert.equal(manual.calls(), 2);
    assert.equal(manual.maxActive(), 1);
  });

  it("scheduled polls and retry never create parallel reads", async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const poller = createHealthPoller({
      read: async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await tick(6);
        active -= 1;
        return checking();
      },
      onUpdate: () => undefined,
      pollMs: 2,
      slowMs: 60_000
    });
    for (let i = 0; i < 10; i += 1) {
      poller.retry();
      await tick(2);
    }
    await tick(40);
    poller.stop();
    assert.equal(maxActive, 1);
    assert.ok(calls > 1, `expected several sequential reads, saw ${calls}`);
  });
});
