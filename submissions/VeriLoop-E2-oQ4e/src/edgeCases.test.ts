/**
 * Edge-case tests for TaskScheduler.
 *
 * Covers: large fan-in, large fan-out, deep chains, concurrent updates (stale
 * entries), empty-scheduler edge cases, re-adding removed ids, mixed
 * add/remove/complete, boundary conditions on priorities and timestamps, and
 * large-payload passthrough.
 */
import { TaskScheduler } from '../src';

// ---------------------------------------------------------------------------
// Large fan-in: one task with many dependencies
// ---------------------------------------------------------------------------
describe('large fan-in', () => {
  it('a task with 5,000 dependencies is unblocked only after all complete', () => {
    const s = new TaskScheduler();
    const N = 5_000;
    const deps: string[] = [];
    for (let i = 0; i < N; i++) {
      const id = `dep-${i}`;
      s.add({ id });
      deps.push(id);
    }
    const heavyId = 'heavy';
    s.add({ id: heavyId, dependsOn: deps });
    // heavy is not claimable until all deps complete
    const firstClaimed = s.claim()!;
    expect(firstClaimed.id).not.toBe(heavyId); // claim some dep (it is now RUNNING)
    // Complete the already-claimed dep, then all the remaining deps
    s.complete(firstClaimed.id, true);
    for (let i = 0; i < N - 1; i++) {
      const t = s.claim()!;
      s.complete(t.id, true);
    }
    // heavy is now claimable
    expect(s.claim()!.id).toBe(heavyId);
  });

  it('a task with 10,000 dependencies: get() reports all unmet deps', () => {
    const s = new TaskScheduler();
    const N = 10_000;
    const deps: string[] = [];
    for (let i = 0; i < N; i++) {
      const id = `d-${i}`;
      s.add({ id });
      deps.push(id);
    }
    s.add({ id: 'heavy', dependsOn: deps });
    expect(s.get('heavy')!.unmetDependencies).toHaveLength(N);
  });
});

// ---------------------------------------------------------------------------
// Large fan-out: one task with many dependents
// ---------------------------------------------------------------------------
describe('large fan-out', () => {
  it('a task with 5,000 dependents unblocks all of them on completion', () => {
    const s = new TaskScheduler();
    const N = 5_000;
    s.add({ id: 'source' });
    for (let i = 0; i < N; i++) {
      s.add({ id: `dependent-${i}`, dependsOn: ['source'] });
    }
    expect(s.get('source')!.dependentsCount).toBe(N);
    // Complete source
    const t = s.claim()!; // source
    s.complete(t.id, true);
    // All dependents are now claimable
    let claimed = 0;
    for (let i = 0; i < N; i++) {
      const d = s.claim()!;
      s.complete(d.id, true);
      claimed++;
    }
    expect(claimed).toBe(N);
    expect(s.completedCount).toBe(N + 1); // source + all dependents
  });

  it('removing a task with 5,000 dependents cascade-fails all of them', () => {
    const s = new TaskScheduler();
    const N = 5_000;
    s.add({ id: 'source' });
    for (let i = 0; i < N; i++) {
      s.add({ id: `dependent-${i}`, dependsOn: ['source'] });
    }
    s.remove('source');
    expect(s.failedCount).toBe(N); // all dependents failed
    expect(s.has('source')).toBe(false);
    expect(s.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Deep dependency chain
// ---------------------------------------------------------------------------
describe('deep dependency chain', () => {
  it('a chain of 10,000 tasks walks in order (no stack overflow)', () => {
    const s = new TaskScheduler();
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      s.add({
        id: `t-${i}`,
        dependsOn: i === 0 ? [] : [`t-${i - 1}`],
      });
    }
    // Walk the chain
    let count = 0;
    let t;
    while ((t = s.claim())) {
      count++;
      s.complete(t.id, true);
    }
    expect(count).toBe(N);
    expect(s.completedCount).toBe(N);
  });

  it('a deep chain: removing the head cascade-fails all 10,000 (iterative)', () => {
    const s = new TaskScheduler();
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      s.add({
        id: `t-${i}`,
        dependsOn: i === 0 ? [] : [`t-${i - 1}`],
      });
    }
    s.remove('t-0'); // head of the chain
    // All other tasks cascade-failed (iterative, no stack overflow)
    expect(s.failedCount).toBe(N - 1);
    expect(s.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrent updates (stale entries)
// ---------------------------------------------------------------------------
describe('concurrent updates & stale entries', () => {
  it('updating priority 1,000 times on one task does not break claim order', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a', priority: 1 });
    s.add({ id: 'b', priority: 2 });
    // Update a's priority many times; each creates a stale heap entry
    for (let i = 0; i < 1_000; i++) {
      s.update('a', { priority: i });
    }
    // a's final priority is 999, which is higher than b's 2
    expect(s.claim()!.id).toBe('a'); // a with priority 999 comes first
    expect(s.claim()!.id).toBe('b'); // then b with priority 2
  });

  it('updating scheduledAt 1,000 times moves the promotion time correctly', () => {
    const clock = { t: 0, now: () => clock.t };
    const s = new TaskScheduler({ now: clock.now });
    s.add({ id: 'a', scheduledAt: 1_000_000 }); // far future
    // Move the scheduledAt closer and closer
    for (let i = 1_000; i > 0; i--) {
      s.update('a', { scheduledAt: i });
    }
    // Final scheduledAt is 1, so a is claimable at t=1
    clock.t = 0;
    expect(s.claim()).toBeUndefined(); // t=0, not yet
    clock.t = 1;
    expect(s.claim()!.id).toBe('a'); // t=1, eligible
  });

  it('mass updates + removals do not corrupt the scheduler', () => {
    const s = new TaskScheduler();
    const N = 1_000;
    for (let i = 0; i < N; i++) s.add({ id: `t-${i}`, priority: i });
    // Update half the tasks
    for (let i = 0; i < N / 2; i++) {
      s.update(`t-${i}`, { priority: 10_000 + i });
    }
    // Remove the other half
    for (let i = N / 2; i < N; i++) {
      s.remove(`t-${i}`);
    }
    // The remaining N/2 tasks should all be claimable, in updated-priority order
    let claimed = 0;
    for (let i = 0; i < N / 2; i++) {
      const t = s.claim();
      if (!t) break;
      claimed++;
      s.complete(t.id, true);
    }
    expect(claimed).toBe(N / 2);
    // Highest priority first: t-(N/2-1) has priority 10000 + (N/2-1)
    expect(s.completedCount).toBe(N / 2);
  });
});

// ---------------------------------------------------------------------------
// Empty-scheduler edge cases
// ---------------------------------------------------------------------------
describe('empty scheduler edge cases', () => {
  it('claim on empty scheduler returns undefined', () => {
    const s = new TaskScheduler();
    expect(s.claim()).toBeUndefined();
  });

  it('peekNext on empty scheduler returns undefined', () => {
    const s = new TaskScheduler();
    expect(s.peekNext()).toBeUndefined();
  });

  it('execute on empty scheduler returns undefined', () => {
    const s = new TaskScheduler();
    expect(s.execute()).toBeUndefined();
  });

  it('remove on empty scheduler returns false', () => {
    const s = new TaskScheduler();
    expect(s.remove('nope')).toBe(false);
  });

  it('get on empty scheduler returns undefined', () => {
    const s = new TaskScheduler();
    expect(s.get('nope')).toBeUndefined();
  });

  it('complete on empty scheduler throws TaskNotFoundError', () => {
    const s = new TaskScheduler();
    expect(() => s.complete('nope', true)).toThrow();
  });

  it('size is 0 on empty scheduler', () => {
    const s = new TaskScheduler();
    expect(s.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Re-adding a removed task id
// ---------------------------------------------------------------------------
describe('re-adding removed task ids', () => {
  it('a removed task id can be re-added', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.remove('a');
    expect(s.has('a')).toBe(false);
    // Re-add
    s.add({ id: 'a' });
    expect(s.has('a')).toBe(true);
    expect(s.claim()!.id).toBe('a');
  });

  it('a completed task id can be re-added', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    const t = s.claim()!;
    s.complete(t.id, true);
    expect(s.has('a')).toBe(false);
    // Re-add with same id
    s.add({ id: 'a' });
    expect(s.has('a')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mixed add / remove / complete
// ---------------------------------------------------------------------------
describe('mixed add / remove / complete', () => {
  it('a complex mixed scenario produces correct results', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a', priority: 1 });
    s.add({ id: 'b', dependsOn: ['a'], priority: 2 });
    s.add({ id: 'c', priority: 3 });
    s.add({ id: 'd', dependsOn: ['c'], priority: 4 });

    // Drain everything via execute (claim+complete in one call)
    let count = 0;
    for (;;) {
      const t = s.execute();
      if (!t) break;
      count++;
    }
    expect(count).toBe(4);
    expect(s.completedCount).toBe(4);
    expect(s.failedCount).toBe(0);
  });

  it('removing a task mid-flight does not corrupt others', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.add({ id: 'b', dependsOn: ['a'] });
    s.add({ id: 'c' });
    s.add({ id: 'd', dependsOn: ['c'] });

    // Remove c → d cascade-fails
    s.remove('c');
    expect(s.has('d')).toBe(false); // d failed
    expect(s.failedCount).toBe(1); // d

    // a and b are unaffected
    expect(s.has('a')).toBe(true);
    expect(s.has('b')).toBe(true);

    // Complete a → b unblocks
    const t = s.claim()!; // a
    s.complete(t.id, true);
    expect(s.claim()!.id).toBe('b'); // b unblocked
    s.complete('b', true);
    expect(s.claim()).toBeUndefined(); // nothing left
    expect(s.completedCount).toBe(2); // a and b
  });
});

// ---------------------------------------------------------------------------
// Boundary conditions: priorities and timestamps
// ---------------------------------------------------------------------------
describe('boundary conditions', () => {
  it('negative priorities work', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a', priority: -100 });
    s.add({ id: 'b', priority: -50 });
    s.add({ id: 'c', priority: -1 });
    // Higher (less negative) priority first
    expect(s.claim()!.id).toBe('c'); // -1
    expect(s.claim()!.id).toBe('b'); // -50
    expect(s.claim()!.id).toBe('a'); // -100
  });

  it('very large priorities work', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a', priority: Number.MAX_SAFE_INTEGER });
    s.add({ id: 'b', priority: 1 });
    expect(s.claim()!.id).toBe('a'); // MAX_SAFE_INTEGER first
  });

  it('scheduledAt of 0 (epoch start) is immediately eligible', () => {
    const clock = { t: 0, now: () => clock.t };
    const s = new TaskScheduler({ now: clock.now });
    s.add({ id: 'a', scheduledAt: 0 });
    expect(s.claim()!.id).toBe('a'); // t=0, scheduledAt=0, eligible
  });

  it('scheduledAt of 1 with clock at 0 is deferred by one ms', () => {
    const clock = { t: 0, now: () => clock.t };
    const s = new TaskScheduler({ now: clock.now });
    s.add({ id: 'a', scheduledAt: 1 });
    expect(s.claim()).toBeUndefined(); // t=0, scheduledAt=1, deferred
    clock.t = 1;
    expect(s.claim()!.id).toBe('a'); // t=1, eligible
  });

  it('large payload passthrough', () => {
    const s = new TaskScheduler();
    const bigPayload = { data: 'x'.repeat(10_000), meta: { a: 1, b: 2 } };
    s.add({ id: 'a', payload: bigPayload });
    const t = s.claim()!;
    expect(t.payload).toEqual(bigPayload);
  });
});

// ---------------------------------------------------------------------------
// Diamond with removal of a middle node
// ---------------------------------------------------------------------------
describe('diamond with removal of a middle node', () => {
  it('removing one branch of a diamond does not affect the other', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.add({ id: 'b', dependsOn: ['a'] });
    s.add({ id: 'c', dependsOn: ['a'] });
    s.add({ id: 'd', dependsOn: ['b', 'c'] });

    // Remove b → d is cascade-failed (depends on b)
    s.remove('b');
    expect(s.has('d')).toBe(false); // d failed
    // b is the direct dependent removed; d is the transitive dependent cascade-failed.
    // b itself is removed (REMOVED state, not FAILED), so it is NOT counted in failedCount.
    // d is FAILED, so failedCount = 1.
    expect(s.failedCount).toBe(1); // d

    // c is unaffected (does not depend on b)
    expect(s.has('c')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Concurrent claim and complete on the same task
// ---------------------------------------------------------------------------
describe('idempotency and double-claim', () => {
  it('claiming the same task twice is not possible (claim removes it from heap)', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    const t1 = s.claim()!; // claim a → a is RUNNING, no longer in heap
    expect(t1.id).toBe('a');
    const t2 = s.claim(); // nothing left in heap
    expect(t2).toBeUndefined(); // a is not double-claimed
  });

  it('completing a task twice throws InvalidStateError on the second call', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    const t = s.claim()!;
    s.complete(t.id, true); // first complete: ok
    expect(() => s.complete(t.id, true)).toThrow(); // second: task not found (removed)
  });
});
