import { describe, it, expect } from "vitest";
import { TaskScheduler } from "../src/scheduler.js";

/**
 * Scale & performance suite. These tests run the scheduler at production
 * scale (up to 1M tasks) to validate the complexity claims in the README
 * and to give a concrete performance envelope.
 *
 * Timing is asserted with generous upper bounds so the suite is not
 * flaky on CI, while still catching O(n) or worse regressions in hot
 * paths (the heap must stay O(log n)).
 */

const NOW = Date.now();

/** Deterministic PRNG (mulberry32) so the workload is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("TaskScheduler — scale (1M tasks)", () => {
  it("ingests 1M independent tasks in reasonable time", () => {
    const s = new TaskScheduler();
    const N = 1_000_000;
    const rng = mulberry32(42);
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      s.addTask(
        {
          id: `t${i}`,
          priority: Math.floor(rng() * 100),
          scheduledAt: NOW + Math.floor(rng() * 86_400_000), // within a day
        },
        NOW,
      );
    }
    const ingestMs = performance.now() - t0;
    expect(s.size).toBe(N);
    // Ingestion must be well under a second per 100k tasks. Generous bound:
    // 1M adds in < 40s (allows slow CI), expecting far less in practice.
    // Dep-less tasks skip the cycle check, so this is the true O(n log n)
    // heap-ingest envelope.
    expect(ingestMs).toBeLessThan(40_000);
    console.log(`[scale] 1M ingest: ${(ingestMs / 1000).toFixed(1)}s, heap=${s.stats().heapSize}`);
    // Heap invariant must hold at scale.
    expect(s.selfCheck().heapOk).toBe(true);
  }, 120_000); // vitest per-test timeout

  it("nextExecutableTask stays O(1) on the common path at scale", () => {
    const s = new TaskScheduler();
    const N = 200_000;
    const rng = mulberry32(7);
    for (let i = 0; i < N; i++) {
      s.addTask(
        { id: `a${i}`, priority: Math.floor(rng() * 10), scheduledAt: NOW },
        NOW,
      );
    }
    // 10k peeks must be fast: this is the hot path. Bound: < 100ms total.
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) {
      const n = s.nextExecutableTask(NOW);
      expect(n).not.toBeNull(); // always something due
    }
    const peekMs = performance.now() - t0;
    expect(peekMs).toBeLessThan(100);
  }, 60_000);

  it("drains a 100k-task diamond DAG to completion correctly", () => {
    const s = new TaskScheduler();
    // diamond: 2 levels of 50k each + 1 root + 1 leaf
    const L1 = 50_000;
    const L2 = 50_000;
    const tAdd0 = performance.now();
    s.addTask({ id: "root" }, NOW);
    const mids: string[] = [];
    for (let i = 0; i < L1; i++) {
      const id = `m${i}`;
      s.addTask({ id, dependsOn: ["root"], scheduledAt: NOW }, NOW);
      mids.push(id);
    }
    for (let i = 0; i < L2; i++) {
      s.addTask({ id: `d${i}`, dependsOn: [mids[i % L1] as string], scheduledAt: NOW }, NOW);
    }
    const leaf = "leaf";
    s.addTask({ id: leaf, dependsOn: mids.slice(0, 10), scheduledAt: NOW }, NOW);
    const addMs = performance.now() - tAdd0;
    console.log(`[scale] diamond add: ${(addMs / 1000).toFixed(1)}s`);

    const t0 = performance.now();
    let done = 0;
    for (;;) {
      const n = s.claimTask(NOW);
      if (!n) break;
      s.succeedTask(n.id);
      done++;
    }
    const drainMs = performance.now() - t0;
    console.log(`[scale] diamond drain: ${(drainMs / 1000).toFixed(1)}s for ${done} tasks`);

    // Every task exactly once: 1 root + L1 + L2 + 1 leaf
    expect(done).toBe(1 + L1 + L2 + 1);
    expect(s.stats().byState.SUCCEEDED).toBe(done);
    expect(s.nextExecutableTask(NOW)).toBeNull();
    // Drain must complete in reasonable time (generous: < 60s).
    expect(drainMs).toBeLessThan(60_000);
  }, 300_000);

  it("validateGraph on a 100k-node chain does not overflow the stack", () => {
    const s = new TaskScheduler();
    const N = 100_000;
    const t0 = performance.now();
    s.addTask({ id: `v0`, scheduledAt: NOW }, NOW);
    for (let i = 1; i < N; i++) {
      s.addTask({ id: `v${i}`, dependsOn: [`v${i - 1}`], scheduledAt: NOW }, NOW);
    }
    const addMs = performance.now() - t0;
    // 100k adds each triggering an O(V+E) cycle check is O(N^2) total but
    // with a small constant — this validates the envelope at a scale that
    // fits in the worker heap. (1M is validated in the ingest test, which
    // uses dep-less tasks to keep the cycle check out of the hot path.)
    expect(s.size).toBe(N);
    const report = s.validateGraph();
    expect(report.cycle).toBeNull();
    expect(report.nodes).toBe(N);
    expect(report.edges).toBe(N - 1);
    console.log(`[scale] 100k chain: add=${(addMs / 1000).toFixed(1)}s`);
  }, 600_000);

  it("memory: 1M tasks is feasible (no unbounded growth per op)", () => {
    const s = new TaskScheduler();
    const N = 1_000_000;
    for (let i = 0; i < N; i++) {
      s.addTask({ id: `m${i}`, priority: i % 10, scheduledAt: NOW + (i % 1000) }, NOW);
    }
    const before = process.memoryUsage().heapUsed;
    const n = s.nextExecutableTask(NOW); // one peek
    const after = process.memoryUsage().heapUsed;
    // A single peek must not allocate on the order of MBs. Allow 5MB headroom
    // (GC noise) — a regression that copies the whole heap per peek would
    // blow this budget.
    expect(n).not.toBeNull();
    expect(after - before).toBeLessThan(5 * 1024 * 1024);
    void s;
  }, 120_000);
});
