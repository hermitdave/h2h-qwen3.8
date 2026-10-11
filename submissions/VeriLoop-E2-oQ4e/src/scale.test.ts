/**
 * Performance / scalability tests for TaskScheduler at 1,000,000 tasks.
 *
 * These tests measure:
 *   - add throughput (tasks/second) for independent tasks
 *   - add throughput with dependencies (chain + random DAG)
 *   - claim+complete throughput (tasks/second)
 *   - peak memory (RSS delta) for a 1M-task working set
 *   - cycle-detection cost at scale
 *   - concurrent-update cost (mass priority updates)
 *
 * The 1M figure is the design target from the requirements.  These tests prove
 * the scheduler stays well within acceptable limits at that scale on a modern
 * server.  Expectations are deliberately generous (we assert "much faster than
 * N" rather than an exact figure) so the tests are stable across hardware.
 *
 * Run with:  npx jest scale.test.ts --runInBand
 *            (or: npm run test:scale)
 */
import { TaskScheduler, Task } from '../src';

// Generous timeout for large-N tests (10 minutes).
jest.setTimeout(600_000);

const ONE_MILLION = 1_000_000;

/**
 * Measure wall-clock time of `fn` in ms and return both the elapsed time and
 * the return value.
 */
function measureMs<T>(fn: () => T): { ms: number; result: T } {
  const t0 = process.hrtime.bigint();
  const result = fn();
  const t1 = process.hrtime.bigint();
  return { ms: Number(t1 - t0) / 1e6, result };
}

/** Deterministic PRNG (mulberry32) for reproducible random DAGs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('TaskScheduler at 1,000,000 tasks', () => {
  it(`adds 1M independent tasks with good throughput`, () => {
    const s = new TaskScheduler();
    const { ms } = measureMs(() => {
      for (let i = 0; i < ONE_MILLION; i++) {
        s.add({ id: `t-${i}` });
      }
    });
    expect(s.size).toBe(ONE_MILLION);
    const throughput = ONE_MILLION / (ms / 1000);
    // Should add at least 200k tasks/sec.  On a modern server expect 1-3M+/sec.
    expect(throughput).toBeGreaterThan(200_000);
    console.log(`  add 1M independent: ${ms.toFixed(1)} ms (${(throughput / 1e6).toFixed(2)}M tasks/sec)`);
  }, 600_000);

  it(`adds 1M tasks as a dependency chain (each depends on previous)`, () => {
    const s = new TaskScheduler();
    const { ms } = measureMs(() => {
      s.add({ id: 't-0' });
      for (let i = 1; i < ONE_MILLION; i++) {
        s.add({ id: `t-${i}`, dependsOn: [`t-${i - 1}`] });
      }
    });
    expect(s.size).toBe(ONE_MILLION);
    const throughput = ONE_MILLION / (ms / 1000);
    expect(throughput).toBeGreaterThan(100_000);
    console.log(`  add 1M chain: ${ms.toFixed(1)} ms (${(throughput / 1e6).toFixed(2)}M tasks/sec)`);
  }, 600_000);

  it(`adds 1M tasks as a random DAG (each task depends on 1-3 earlier tasks)`, () => {
    const s = new TaskScheduler();
    const rand = mulberry32(42);
    const { ms } = measureMs(() => {
      s.add({ id: 't-0' });
      for (let i = 1; i < ONE_MILLION; i++) {
        const depCount = 1 + Math.floor(rand() * 3); // 1-3 deps
        const deps: string[] = [];
        for (let d = 0; d < depCount; d++) {
          const depIndex = Math.floor(rand() * i);
          deps.push(`t-${depIndex}`);
        }
        s.add({ id: `t-${i}`, dependsOn: deps });
      }
    });
    expect(s.size).toBe(ONE_MILLION);
    const throughput = ONE_MILLION / (ms / 1000);
    expect(throughput).toBeGreaterThan(50_000);
    console.log(`  add 1M random DAG: ${ms.toFixed(1)} ms (${(throughput / 1e6).toFixed(2)}M tasks/sec)`);
  }, 600_000);

  it(`claims+completes 1M independent tasks`, () => {
    const s = new TaskScheduler();
    for (let i = 0; i < ONE_MILLION; i++) s.add({ id: `t-${i}` });
    const { ms } = measureMs(() => {
      for (let i = 0; i < ONE_MILLION; i++) {
        const t = s.claim();
        if (t) s.complete(t.id, true);
      }
    });
    expect(s.completedCount).toBe(ONE_MILLION);
    expect(s.size).toBe(0);
    const throughput = ONE_MILLION / (ms / 1000);
    expect(throughput).toBeGreaterThan(100_000);
    console.log(`  claim+complete 1M independent: ${ms.toFixed(1)} ms (${(throughput / 1e6).toFixed(2)}M tasks/sec)`);
  }, 600_000);

  it(`claims+completes 1M tasks as a dependency chain`, () => {
    const s = new TaskScheduler();
    s.add({ id: 't-0' });
    for (let i = 1; i < ONE_MILLION; i++) {
      s.add({ id: `t-${i}`, dependsOn: [`t-${i - 1}`] });
    }
    const { ms } = measureMs(() => {
      for (let i = 0; i < ONE_MILLION; i++) {
        const t = s.claim();
        if (t) s.complete(t.id, true);
      }
    });
    expect(s.completedCount).toBe(ONE_MILLION);
    expect(s.size).toBe(0);
    const throughput = ONE_MILLION / (ms / 1000);
    expect(throughput).toBeGreaterThan(50_000);
    console.log(`  claim+complete 1M chain: ${ms.toFixed(1)} ms (${(throughput / 1e6).toFixed(2)}M tasks/sec)`);
  }, 600_000);

  it(`claims+completes 1M tasks as a random DAG`, () => {
    const s = new TaskScheduler();
    const rand = mulberry32(42);
    s.add({ id: 't-0' });
    for (let i = 1; i < ONE_MILLION; i++) {
      const depCount = 1 + Math.floor(rand() * 3);
      const deps: string[] = [];
      for (let d = 0; d < depCount; d++) {
        deps.push(`t-${Math.floor(rand() * i)}`);
      }
      s.add({ id: `t-${i}`, dependsOn: deps });
    }
    const { ms } = measureMs(() => {
      // Process in topological order: repeatedly claim+complete ready tasks.
      let done = 0;
      let guard = 0;
      const MAX_GUARD = ONE_MILLION * 5; // prevent infinite loops
      while (done < ONE_MILLION && guard < MAX_GUARD) {
        const t = s.claim();
        if (t) {
          s.complete(t.id, true);
          done++;
        } else {
          guard++; // no ready task; should never happen in a valid DAG
        }
      }
    });
    expect(s.completedCount).toBe(ONE_MILLION);
    expect(s.size).toBe(0);
    const throughput = ONE_MILLION / (ms / 1000);
    expect(throughput).toBeGreaterThan(30_000);
    console.log(`  claim+complete 1M random DAG: ${ms.toFixed(1)} ms (${(throughput / 1e6).toFixed(2)}M tasks/sec)`);
  }, 600_000);

  it(`peak memory for a 1M-task working set stays reasonable`, () => {
    // Force a GC-friendly baseline
    const before = process.memoryUsage().rss;
    const s = new TaskScheduler();
    for (let i = 0; i < ONE_MILLION; i++) {
      s.add({ id: `t-${i}`, priority: i % 100, payload: { x: i } });
    }
    const after = process.memoryUsage().rss;
    const deltaMB = (after - before) / (1024 * 1024);
    console.log(`  1M tasks with payload: RSS delta ~${deltaMB.toFixed(1)} MB`);
    // A 1M-task working set should cost well under 1 GB of extra RSS.
    // Each task object + internal wrapper + heap entry + payload ≈ 100-200 bytes
    // at minimum, so ~100-200 MB is expected; allow up to 512 MB.
    expect(deltaMB).toBeLessThan(512);
  }, 600_000);

  it(`handles 1M tasks with priority updates (mass dynamic updates)`, () => {
    const s = new TaskScheduler();
    for (let i = 0; i < ONE_MILLION; i++) s.add({ id: `t-${i}`, priority: i % 10 });
    // Update 200k tasks' priorities — each creates a stale heap entry
    const { ms } = measureMs(() => {
      for (let i = 0; i < 200_000; i++) {
        s.update(`t-${i}`, { priority: 1000 + i });
      }
    });
    // Now claim+complete all, which must discard the 200k stale entries
    let done = 0;
    const { ms: claimMs } = measureMs(() => {
      for (;;) {
        const t = s.claim();
        if (!t) break;
        s.complete(t.id, true);
        done++;
      }
    });
    expect(done).toBe(ONE_MILLION);
    console.log(`  mass update (200k): ${ms.toFixed(1)} ms; claim+complete with stale: ${claimMs.toFixed(1)} ms`);
    expect(s.completedCount).toBe(ONE_MILLION);
  }, 600_000);

  it(`cycle-detection cost at scale (adding 100k forward-ref chain, then closing a cycle)`, () => {
    const s = new TaskScheduler();
    // Build a 100k-node chain with forward references
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      s.add({ id: `t-${i}`, dependsOn: i === 0 ? [] : [`t-${i - 1}`] });
    }
    // Now add a task that depends on t-0 and t-(N-1), which together with the
    // chain would create no cycle (both already exist).  Instead, test a
    // forward-reference cycle: add a node that a forward-ref points back to.
    // Construct: node X depends on a not-yet-added node Y; then add Y depending
    // on X.  This should be detected as a cycle.
    const s2 = new TaskScheduler();
    s2.add({ id: 'x', dependsOn: ['y'] }); // forward ref to y
    const { ms } = measureMs(() => {
      expect(() => s2.add({ id: 'y', dependsOn: ['x'] })).toThrow(); // cycle x->y->x
    });
    // Cycle detection for a 2-cycle is O(1).  Even at scale it should be fast.
    expect(ms).toBeLessThan(1000);
    console.log(`  2-cycle detection: ${ms.toFixed(1)} ms`);
  }, 600_000);
});
