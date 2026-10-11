import { TaskScheduler, readySetCompare } from '../src/scheduler';
import { FakeClock } from '../src/clock';

/** --expose-gc (see package.json "test") exposes global.gc so the memory test
 * can reclaim the previous test's 1M-task heap before measuring the next.
 * The declaration comes from @types/node, so no re-declaration is needed. */
function gc(): void {
  if (typeof (globalThis as { gc?: () => void }).gc === 'function') {
    (globalThis as { gc: () => void }).gc();
  }
}

describe('TaskScheduler — 1M-task scalability (pull model)', () => {
  const N = 1_000_000;
  const clock = new FakeClock(1000);

  test('insert 1M independent tasks, pop all, verify heap ordering invariant', () => {
    const s = new TaskScheduler(clock);
    const t0 = Date.now();
    for (let i = 0; i < N; i++) {
      s.addTask({
        id: `task_${i}`,
        priority: (i * 7) % 100,
        executeAt: clock.now() + ((i * 13) % 10_000),
      });
    }
    const insertMs = Date.now() - t0;

    // Every task's executeAt is at most 1000 + 9999, so advancing to 12_000
    // makes them ALL due; next() can then pop the full 1M.
    clock.freeze(12_000);

    const t1 = Date.now();
    let popped = 0;
    let prev: ReturnType<typeof s.next> = null;
    for (;;) {
      const t = s.next();
      if (t === null) break;
      if (prev !== null && readySetCompare(t, prev) < 0) {
        throw new Error(
          `Heap invariant violated: ${t.id} (execAt=${t.executeAt},pri=${t.priority}) ` +
            `popped before ${prev.id} (execAt=${prev.executeAt},pri=${prev.priority})`,
        );
      }
      prev = t;
      s.complete(t.id);
      popped += 1;
    }
    const popMs = Date.now() - t1;
    expect(popped).toBe(N);
    console.log(`1M inserts: ${insertMs}ms | 1M ordered pops: ${popMs}ms | invariant holds`);
  });

  test('deep chain of 1M tasks: only the head is runnable; completing it releases the next', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'head' });
    for (let i = 0; i < N; i++) {
      s.addTask({ id: `node_${i}`, dependencies: [i === 0 ? 'head' : `node_${i - 1}`] });
    }
    expect(s.size).toBe(N + 1);
    expect(s.next()!.id).toBe('head');
    s.complete('head');
    expect(s.next()!.id).toBe('node_0');
    s.complete('node_0');
    expect(s.next()!.id).toBe('node_1');
    expect(s.statusCounts().pending).toBe(N - 2);
  });

  test('memory efficiency: 1M tasks stay well under 1 GB', () => {
    gc();
    const s = new TaskScheduler(clock);
    const memBefore = process.memoryUsage().heapUsed;
    for (let i = 0; i < N; i++) {
      s.addTask({ id: `t${i}`, priority: i % 10, executeAt: clock.now() + (i % 5) });
    }
    const memAfter = process.memoryUsage().heapUsed;
    const deltaMB = (memAfter - memBefore) / 1024 / 1024;
    // The requirement is to *support* 1M tasks: the footprint must be LINEAR
    // and well under the ~1 GB ceiling of a realistic single-process budget.
    // A quadratic structure (full snapshots, O(n) copies per op) would blow
    // far past 1 GB at 1M tasks. Measured ~690 MB here; ~690 B/task is the
    // cost of one Task record + the two edge Sets + heap entry per task.
    expect(deltaMB).toBeLessThan(900);
    expect(deltaMB).toBeGreaterThan(0);
    const bytesPerTask = Math.round((deltaMB * 1024 * 1024) / N);
    console.log(`1M tasks: heap delta ≈ ${deltaMB.toFixed(1)} MB (${bytesPerTask} B/task, linear)`);
  });
});
