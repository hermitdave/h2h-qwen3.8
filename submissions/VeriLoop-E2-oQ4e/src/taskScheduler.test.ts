/**
 * TaskScheduler unit tests.
 *
 * Covers: basic add/complete, priority ordering, dependency tracking, forward
 * references, execution timestamps, cycle detection, dynamic updates, removal
 * + cascade-fail, execution failure + cascade, peekNext, claim, execute,
 * get/has, error types, and an end-to-end dependency-chain walk.
 */
import {
  TaskScheduler,
  DuplicateTaskError,
  SelfDependencyError,
  CycleError,
  TaskNotFoundError,
  InvalidStateError,
  Task,
} from '../src';

/** A fake injectable clock for deterministic timestamp tests. */
function clockOf(t: number): { now: () => number; set: (v: number) => void } {
  let cur = t;
  return {
    now: () => cur,
    set: (v) => { cur = v; },
  };
}

// ---------------------------------------------------------------------------
// Basic add & complete
// ---------------------------------------------------------------------------
describe('basic add & complete', () => {
  it('adds a task with no dependencies and makes it immediately claimable', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    expect(s.size).toBe(1);
    expect(s.claim()!.id).toBe('a');
  });

  it('a completed task is removed from the live map', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    const t = s.claim()!;
    s.complete(t.id, true);
    expect(s.has('a')).toBe(false);
    expect(s.completedCount).toBe(1);
  });

  it('throws DuplicateTaskError on re-adding the same id', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    expect(() => s.add({ id: 'a' })).toThrow(DuplicateTaskError);
  });

  it('addedCount tracks all tasks ever added', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.add({ id: 'b' });
    const t = s.claim()!;
    s.complete(t.id, true);
    expect(s.addedCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Priority ordering
// ---------------------------------------------------------------------------
describe('priority ordering', () => {
  it('claims higher-priority tasks first', () => {
    const s = new TaskScheduler();
    s.add({ id: 'low', priority: 1 });
    s.add({ id: 'high', priority: 10 });
    s.add({ id: 'mid', priority: 5 });
    expect(s.claim()!.id).toBe('high');
    expect(s.claim()!.id).toBe('mid');
    expect(s.claim()!.id).toBe('low');
  });

  it('higher priority wins even when added later', () => {
    const s = new TaskScheduler();
    s.add({ id: 'first', priority: 1 });
    s.add({ id: 'second', priority: 100 });
    expect(s.claim()!.id).toBe('second');
  });

  it('ties broken by earlier scheduledAt, then by insertion order (FIFO)', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a', priority: 5, scheduledAt: 10 });
    s.add({ id: 'b', priority: 5, scheduledAt: 10 });
    // Both eligible; FIFO -> a then b
    expect(s.claim()!.id).toBe('a');
    expect(s.claim()!.id).toBe('b');
  });

  it('default priority is 0', () => {
    const s = new TaskScheduler();
    s.add({ id: 'x' });
    expect(s.get('x')!.priority).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Dependency tracking
// ---------------------------------------------------------------------------
describe('dependency tracking', () => {
  it('a task with unmet dependencies is not claimable', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.add({ id: 'b', dependsOn: ['a'] });
    expect(s.claim()!.id).toBe('a'); // only a is ready
    expect(s.claim()).toBeUndefined(); // b still waiting
    s.complete('a', true);
    expect(s.claim()!.id).toBe('b'); // b unblocked
  });

  it('a task with multiple dependencies waits for ALL of them', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.add({ id: 'b' });
    s.add({ id: 'c', dependsOn: ['a', 'b'] });
    expect(s.claim()!.id).toBe('a');
    expect(s.claim()!.id).toBe('b');
    expect(s.claim()).toBeUndefined(); // c waiting
    s.complete('a', true);
    expect(s.claim()).toBeUndefined(); // c still waiting for b
    s.complete('b', true);
    expect(s.claim()!.id).toBe('c');
  });

  it('a task depending on an already-completed task is immediately ready', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.add({ id: 'b', dependsOn: ['a'] });
    // Claim and complete a directly
    expect(s.claim()!.id).toBe('a'); // FIFO: a was added first
    s.complete('a', true); // a done → b unblocks
    // b is now dep-ready, claimable
    expect(s.claim()!.id).toBe('b');
    expect(s.claim()).toBeUndefined(); // nothing left
  });

  it('a task depending on two already-completed tasks is immediately ready', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.add({ id: 'b' });
    s.add({ id: 'c', dependsOn: ['a', 'b'] });
    // complete a and b (order doesn't matter for c's readiness)
    s.execute(); // a or b
    s.execute(); // the other of a/b
    // both a and b are now completed; c is dep-ready
    expect(s.claim()!.id).toBe('c');
  });

  it('get() reports unmet dependencies correctly', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.add({ id: 'b', dependsOn: ['a'] });
    expect(s.get('b')!.unmetDependencies).toEqual(['a']);
    const t = s.claim()!; // a
    s.complete(t.id, true);
    expect(s.get('b')!.unmetDependencies).toEqual([]);
  });

  it('get() reports dependentsCount', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.add({ id: 'b', dependsOn: ['a'] });
    s.add({ id: 'c', dependsOn: ['a'] });
    expect(s.get('a')!.dependentsCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Forward references
// ---------------------------------------------------------------------------
describe('forward references', () => {
  it('allows adding a task that depends on a not-yet-added task', () => {
    const s = new TaskScheduler();
    // b depends on a, but a does not exist yet
    s.add({ id: 'b', dependsOn: ['a'] });
    expect(s.size).toBe(1);
    expect(s.claim()).toBeUndefined(); // b waiting for a
    // Now add a
    s.add({ id: 'a' });
    expect(s.claim()!.id).toBe('a'); // a is ready
    s.complete('a', true);
    expect(s.claim()!.id).toBe('b'); // b unblocked
  });

  it('a chain of forward references resolves correctly', () => {
    const s = new TaskScheduler();
    // Build a chain c -> b -> a, all added with forward references
    s.add({ id: 'c', dependsOn: ['b'] });
    s.add({ id: 'b', dependsOn: ['a'] });
    s.add({ id: 'a' });
    expect(s.claim()!.id).toBe('a');
    s.complete('a', true);
    expect(s.claim()!.id).toBe('b');
    s.complete('b', true);
    expect(s.claim()!.id).toBe('c');
    s.complete('c', true);
    expect(s.claim()).toBeUndefined();
  });

  it('a task with multiple forward references resolves when all are added', () => {
    const s = new TaskScheduler();
    s.add({ id: 'z', dependsOn: ['a', 'b'] });
    s.add({ id: 'a' });
    expect(s.claim()!.id).toBe('a');
    s.complete('a', true);
    expect(s.claim()).toBeUndefined(); // z still waiting for b
    s.add({ id: 'b' });
    expect(s.claim()!.id).toBe('b');
    s.complete('b', true);
    expect(s.claim()!.id).toBe('z'); // z unblocked
  });
});

// ---------------------------------------------------------------------------
// Execution timestamps
// ---------------------------------------------------------------------------
describe('execution timestamps', () => {
  it('a task scheduled in the future is not claimable until its time', () => {
    const clock = clockOf(1000);
    const s = new TaskScheduler({ now: clock.now });
    s.add({ id: 'a', scheduledAt: 5000 }); // scheduled for t=5000
    expect(s.claim()).toBeUndefined(); // t=1000, not yet
    clock.set(5000);
    expect(s.claim()!.id).toBe('a'); // now eligible
  });

  it('a task scheduled in the past is immediately claimable', () => {
    const clock = clockOf(1000);
    const s = new TaskScheduler({ now: clock.now });
    s.add({ id: 'a', scheduledAt: 500 }); // scheduled for t=500, already past
    expect(s.claim()!.id).toBe('a');
  });

  it('a deferred task with deps is only claimable after both deps AND time', () => {
    const clock = clockOf(1000);
    const s = new TaskScheduler({ now: clock.now });
    s.add({ id: 'a' });
    s.add({ id: 'b', dependsOn: ['a'], scheduledAt: 5000 });
    // claim a
    const t = s.claim()!;
    expect(t.id).toBe('a');
    s.complete(t.id, true);
    // b is dep-ready but scheduled for t=5000
    expect(s.claim()).toBeUndefined(); // t=1000, not yet
    clock.set(5000);
    expect(s.claim()!.id).toBe('b');
  });

  it('promotion moves deferred tasks into the run-heap at the right time', () => {
    const clock = clockOf(0);
    const s = new TaskScheduler({ now: clock.now });
    s.add({ id: 'a', scheduledAt: 100, priority: 1 });
    s.add({ id: 'b', scheduledAt: 200, priority: 10 });
    s.add({ id: 'c', priority: 5 }); // no scheduledAt -> immediate
    expect(s.claim()!.id).toBe('c'); // eligible at t=0
    expect(s.claim()).toBeUndefined(); // a and b deferred
    clock.set(100);
    expect(s.claim()!.id).toBe('a'); // promoted at t=100
    clock.set(200);
    expect(s.claim()!.id).toBe('b'); // promoted at t=200
  });
});

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------
describe('cycle detection', () => {
  it('detects a self-dependency', () => {
    const s = new TaskScheduler();
    expect(() => s.add({ id: 'a', dependsOn: ['a'] })).toThrow(SelfDependencyError);
  });

  it('detects a direct 2-cycle via forward references', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a', dependsOn: ['b'] }); // a -> b (forward)
    expect(() => s.add({ id: 'b', dependsOn: ['a'] })).toThrow(CycleError); // b -> a closes cycle
  });

  it('detects a 3-cycle via forward references', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a', dependsOn: ['c'] }); // a -> c (forward)
    s.add({ id: 'b', dependsOn: ['a'] }); // b -> a
    expect(() => s.add({ id: 'c', dependsOn: ['b'] })).toThrow(CycleError); // c -> b closes cycle
  });

  it('does NOT flag a valid diamond as a cycle', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.add({ id: 'b', dependsOn: ['a'] });
    s.add({ id: 'c', dependsOn: ['a'] });
    s.add({ id: 'd', dependsOn: ['b', 'c'] }); // diamond, no cycle
    // all 4 should be addable without error
    expect(s.size).toBe(4);
  });

  it('a cycle error carries the cycle path', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a', dependsOn: ['b'] });
    try {
      s.add({ id: 'b', dependsOn: ['a'] });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CycleError);
      expect((e as CycleError).path).toContain('a');
      expect((e as CycleError).path).toContain('b');
    }
  });

  it('a failed add (cycle) does not corrupt existing state', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a', dependsOn: ['b'] });
    expect(() => s.add({ id: 'b', dependsOn: ['a'] })).toThrow(CycleError);
    // a should still be live and correct
    expect(s.has('a')).toBe(true);
    expect(s.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Dynamic updates
// ---------------------------------------------------------------------------
describe('dynamic updates', () => {
  it('updating priority reorders claim order', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a', priority: 1 });
    s.add({ id: 'b', priority: 2 });
    // Bump a to be highest priority
    s.update('a', { priority: 10 });
    expect(s.claim()!.id).toBe('a'); // now a is highest
    expect(s.claim()!.id).toBe('b');
  });

  it('updating scheduledAt of a deferred task moves its promotion time', () => {
    const clock = clockOf(0);
    const s = new TaskScheduler({ now: clock.now });
    s.add({ id: 'a', scheduledAt: 1000 }); // deferred until t=1000
    // Move it earlier
    s.update('a', { scheduledAt: 100 });
    expect(s.claim()).toBeUndefined(); // t=0, still deferred
    clock.set(100);
    expect(s.claim()!.id).toBe('a'); // promoted at t=100, not 1000
  });

  it('updating a task with unmet dependencies stores the new values', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.add({ id: 'b', dependsOn: ['a'], priority: 1 });
    // b is not dep-ready, so update just stores values
    s.update('b', { priority: 100 });
    expect(s.get('b')!.priority).toBe(100);
    // complete a -> b becomes ready with new priority
    const t = s.claim()!; // a
    s.complete(t.id, true);
    // b is now claimable with the updated priority
    expect(s.claim()!.id).toBe('b');
  });

  it('updating priority does not affect a completed task', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.add({ id: 'b', dependsOn: ['a'] });
    const t = s.claim()!; // a
    s.complete(t.id, true);
    const t2 = s.claim()!; // b
    s.complete(t2.id, true);
    expect(() => s.update('a', { priority: 5 })).toThrow(TaskNotFoundError);
    expect(() => s.update('b', { priority: 5 })).toThrow(TaskNotFoundError);
  });

  it('updating a removed task throws', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.remove('a');
    expect(() => s.update('a', { priority: 5 })).toThrow(TaskNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Removal & cascade-fail
// ---------------------------------------------------------------------------
describe('removal & cascade-fail', () => {
  it('removes a task and returns true', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    expect(s.remove('a')).toBe(true);
    expect(s.has('a')).toBe(false);
  });

  it('removing a non-existent task returns false', () => {
    const s = new TaskScheduler();
    expect(s.remove('nope')).toBe(false);
  });

  it('cascade-fails a dependent on removal', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.add({ id: 'b', dependsOn: ['a'] });
    s.remove('a'); // a removed, b can never run
    expect(s.has('a')).toBe(false);
    expect(s.has('b')).toBe(false); // b cascade-failed
    expect(s.failedCount).toBe(1);
  });

  it('cascade-fails transitive dependents (chain) on removal', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.add({ id: 'b', dependsOn: ['a'] });
    s.add({ id: 'c', dependsOn: ['b'] });
    s.add({ id: 'd', dependsOn: ['c'] });
    s.remove('a');
    expect(s.has('a')).toBe(false);
    expect(s.has('b')).toBe(false);
    expect(s.has('c')).toBe(false);
    expect(s.has('d')).toBe(false);
    expect(s.failedCount).toBe(3); // b, c, d
  });

  it('removing a leaf (no dependents) does not cascade', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.add({ id: 'b' });
    s.remove('a');
    expect(s.failedCount).toBe(0);
    expect(s.has('b')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Execution failure & cascade
// ---------------------------------------------------------------------------
describe('execution failure & cascade', () => {
  it('a failed task cascade-fails its dependents', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.add({ id: 'b', dependsOn: ['a'] });
    const t = s.claim()!; // a
    s.complete(t.id, false); // a fails
    expect(s.has('a')).toBe(false);
    expect(s.has('b')).toBe(false); // b cascade-failed
    expect(s.failedCount).toBe(2); // a + b
  });

  it('a failed task does not affect independent tasks', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.add({ id: 'b', dependsOn: ['a'] });
    s.add({ id: 'c' }); // independent
    const t = s.claim()!;
    s.complete(t.id, false);
    expect(s.has('b')).toBe(false); // b failed
    expect(s.has('c')).toBe(true); // c unaffected
  });

  it('transitive dependents are cascade-failed on execution failure', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.add({ id: 'b', dependsOn: ['a'] });
    s.add({ id: 'c', dependsOn: ['b'] });
    const t = s.claim()!; // a
    s.complete(t.id, false);
    expect(s.has('a')).toBe(false);
    expect(s.has('b')).toBe(false);
    expect(s.has('c')).toBe(false);
    expect(s.failedCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// peekNext & claim & execute
// ---------------------------------------------------------------------------
describe('peekNext, claim, execute', () => {
  it('peekNext returns the next executable task without removing it', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a', priority: 1 });
    s.add({ id: 'b', priority: 10 });
    expect(s.peekNext()!.id).toBe('b'); // highest priority
    expect(s.peekNext()!.id).toBe('b'); // still there
    expect(s.claim()!.id).toBe('b'); // now actually claimed
    expect(s.peekNext()!.id).toBe('a');
  });

  it('peekNext returns undefined when nothing is executable', () => {
    const s = new TaskScheduler();
    expect(s.peekNext()).toBeUndefined();
  });

  it('peekNext respects execution timestamps', () => {
    const clock = clockOf(0);
    const s = new TaskScheduler({ now: clock.now });
    s.add({ id: 'a', scheduledAt: 1000 });
    expect(s.peekNext()).toBeUndefined(); // deferred
    clock.set(1000);
    expect(s.peekNext()!.id).toBe('a'); // now eligible
  });

  it('execute claims and completes in one call', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.add({ id: 'b', dependsOn: ['a'] });
    const t = s.execute()!; // claims and completes a
    expect(t.id).toBe('a');
    expect(s.has('a')).toBe(false); // completed
    expect(s.has('b')).toBe(true); // b unblocked
    expect(s.execute()!.id).toBe('b');
    expect(s.execute()).toBeUndefined(); // nothing left
  });

  it('claim returns undefined when all tasks are deferred', () => {
    const clock = clockOf(0);
    const s = new TaskScheduler({ now: clock.now });
    s.add({ id: 'a', scheduledAt: 1000 });
    expect(s.claim()).toBeUndefined();
  });

  it('completing a task that is not RUNNING throws InvalidStateError', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    expect(() => s.complete('a', true)).toThrow(InvalidStateError);
  });

  it('completing a non-existent task throws TaskNotFoundError', () => {
    const s = new TaskScheduler();
    expect(() => s.complete('nope', true)).toThrow(TaskNotFoundError);
  });

  it('remove throws nothing for a missing task but returns false', () => {
    const s = new TaskScheduler();
    expect(s.remove('nope')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// get / has / status
// ---------------------------------------------------------------------------
describe('get & has', () => {
  it('get returns undefined for a non-existent task', () => {
    const s = new TaskScheduler();
    expect(s.get('nope')).toBeUndefined();
  });

  it('get returns undefined for a completed task', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    const t = s.claim()!;
    s.complete(t.id, true);
    expect(s.get('a')).toBeUndefined();
  });

  it('has returns true for a live task, false otherwise', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    expect(s.has('a')).toBe(true);
    s.remove('a');
    expect(s.has('a')).toBe(false);
  });

  it('get returns the correct state for a RUNNING task', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.claim(); // a -> RUNNING
    expect(s.get('a')!.state).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// Payload passthrough
// ---------------------------------------------------------------------------
describe('payload passthrough', () => {
  it('preserves the payload on the returned task', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a', payload: { foo: 1, bar: 'baz' } });
    const t = s.claim()!;
    expect(t.payload).toEqual({ foo: 1, bar: 'baz' });
  });

  it('get() returns the payload', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a', payload: 42 });
    expect(s.get('a')!.payload).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// End-to-end dependency chain walk
// ---------------------------------------------------------------------------
describe('end-to-end walk', () => {
  it('walks a 10-task dependency chain in order', () => {
    const s = new TaskScheduler();
    for (let i = 0; i < 10; i++) {
      s.add({
        id: `task-${i}`,
        dependsOn: i === 0 ? [] : [`task-${i - 1}`],
      });
    }
    const order: string[] = [];
    let t;
    while ((t = s.claim())) {
      order.push(t.id);
      s.complete(t.id, true);
    }
    expect(order).toEqual(
      Array.from({ length: 10 }, (_, i) => `task-${i}`)
    );
  });

  it('walks a diamond dependency in a valid order', () => {
    const s = new TaskScheduler();
    s.add({ id: 'a' });
    s.add({ id: 'b', dependsOn: ['a'] });
    s.add({ id: 'c', dependsOn: ['a'] });
    s.add({ id: 'd', dependsOn: ['b', 'c'] });
    // a first, then b/c in any order, then d
    expect(s.claim()!.id).toBe('a');
    s.complete('a', true);
    const first = s.claim()!.id;
    s.complete(first, true);
    const second = s.claim()!.id;
    s.complete(second, true);
    expect(s.claim()!.id).toBe('d');
    s.complete('d', true);
    expect(s.claim()).toBeUndefined();
    expect(s.completedCount).toBe(4);
  });

  it('handles a mix of dependencies, priorities, and timestamps', () => {
    const clock = clockOf(0);
    const s = new TaskScheduler({ now: clock.now });
    s.add({ id: 'a' }); // no deps, no time -> immediate
    s.add({ id: 'b', dependsOn: ['a'], priority: 10 }); // after a, high priority
    s.add({ id: 'c', dependsOn: ['a'], priority: 1, scheduledAt: 500 }); // after a, low priority, deferred
    s.add({ id: 'd', dependsOn: ['b', 'c'] }); // after b and c

    // a is the only thing ready at t=0
    expect(s.claim()!.id).toBe('a');
    s.complete('a', true);

    // At t=0: b is dep-ready (priority 10) and immediate; c is dep-ready but deferred to t=500
    expect(s.claim()!.id).toBe('b'); // b, high priority
    s.complete('b', true);
    expect(s.claim()).toBeUndefined(); // c deferred, d not dep-ready

    clock.set(500); // c becomes eligible
    expect(s.claim()!.id).toBe('c');
    s.complete('c', true);
    expect(s.claim()!.id).toBe('d'); // now dep-ready
    s.complete('d', true);
    expect(s.claim()).toBeUndefined();
    expect(s.completedCount).toBe(4);
  });
});
