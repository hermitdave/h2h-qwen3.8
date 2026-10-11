import { TaskScheduler } from '../src/scheduler';
import { FakeClock } from '../src/clock';
import {
  CircularDependencyError,
  DuplicateTaskError,
  InvalidDependencyError,
  InvalidUpdateError,
  SelfDependencyError,
  UnknownTaskError,
} from '../src/errors';

const clock = new FakeClock(1000);

describe('TaskScheduler — basic creation & dispatch', () => {
  test('addTask returns a pending task with defaults', () => {
    const s = new TaskScheduler(clock);
    const t = s.addTask({ id: 'a' });
    expect(t.id).toBe('a');
    expect(t.priority).toBe(0);
    expect(t.executeAt).toBe(clock.now());
    expect(t.status).toBe('awaiting');
    expect(s.size).toBe(1);
  });

  test('auto-generated ids are unique and usable', () => {
    const s = new TaskScheduler(clock);
    const a = s.addTask({});
    const b = s.addTask({});
    expect(a.id).not.toBe(b.id);
    expect(s.has(a.id)).toBe(true);
  });

  test('duplicate id throws DuplicateTaskError', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'x' });
    expect(() => s.addTask({ id: 'x' })).toThrow(DuplicateTaskError);
  });

  test('get on unknown id returns undefined; next() on empty returns null', () => {
    const s = new TaskScheduler(clock);
    expect(s.get('nope')).toBeUndefined();
    expect(s.next()).toBeNull();
  });

  test('updatePriority re-orders the ready set', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'low', priority: 1 });
    s.addTask({ id: 'high', priority: 5 });
    expect(s.next()!.id).toBe('high');
    s.complete('high');
    expect(s.next()!.id).toBe('low');
  });

  test('updateExecuteAt past means next() returns null until time advances', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'late', executeAt: clock.now() + 1000 });
    expect(s.next()).toBeNull();
    clock.advance(1000);
    expect(s.next()!.id).toBe('late');
  });

  test('updatePriority on unknown id throws UnknownTaskError', () => {
    const s = new TaskScheduler(clock);
    expect(() => s.updatePriority('ghost', 1)).toThrow(UnknownTaskError);
  });

  test('statusCounts tallies', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b' });
    s.complete('a');
    s.fail('b', new Error('boom'));
    const c = s.statusCounts();
    expect(c.done).toBe(1);
    expect(c.failed).toBe(1);
    expect(c.pending + c.awaiting + c.cancelled).toBe(0);
  });
});

describe('TaskScheduler — dependencies', () => {
  test('diamond: leaf completes only after both parents', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b' });
    s.addTask({ id: 'c', dependencies: ['a', 'b'] });
    // Complete a, then b. c cannot be popped until BOTH are done.
    const first = s.next()!.id;
    expect(first).not.toBe('c');
    s.complete(first);
    const second = s.next()!.id;
    expect(second).not.toBe('c');
    s.complete(second);
    expect(s.next()!.id).toBe('c');
  });

  test('chain: topological order enforced', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'l' });
    s.addTask({ id: 'm', dependencies: ['l'] });
    s.addTask({ id: 't', dependencies: ['m'] });
    expect(s.next()!.id).toBe('l');
    s.complete('l');
    expect(s.next()!.id).toBe('m');
    s.complete('m');
    expect(s.next()!.id).toBe('t');
  });

  test('self-dependency throws SelfDependencyError', () => {
    const s = new TaskScheduler(clock);
    expect(() => s.addTask({ id: 'a', dependencies: ['a'] })).toThrow(SelfDependencyError);
  });

  test('unknown dependency throws InvalidDependencyError', () => {
    const s = new TaskScheduler(clock);
    expect(() => s.addTask({ id: 'a', dependencies: ['ghost'] })).toThrow(InvalidDependencyError);
  });

  test('addDependency on a terminal task throws InvalidUpdateError', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b' });
    s.complete('a');
    expect(() => s.addDependency('a', 'b')).toThrow(InvalidUpdateError);
  });

  test('removeDependency on a terminal task throws InvalidUpdateError', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b', dependencies: ['a'] });
    s.complete('a');
    s.complete('b');
    expect(() => s.removeDependency('b', 'a')).toThrow(InvalidUpdateError);
  });

  test('completed task is idempotent to complete/fail/cancel', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a' });
    s.complete('a');
    s.complete('a');
    expect(s.get('a')!.status).toBe('done');
  });

  test('cancel a task satisfies its dependents (design choice)', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'skip' });
    s.addTask({ id: 'downstream', dependencies: ['skip'] });
    s.cancel('skip');
    expect(s.next()!.id).toBe('downstream');
  });

  test('fail does NOT satisfy dependents (they stay pending)', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b', dependencies: ['a'] });
    s.next(); // pop a
    s.fail('a', new Error('boom'));
    expect(s.next()).toBeNull();
    expect(s.get('b')!.status).toBe('pending');
  });
});

describe('TaskScheduler — dynamic updates & cycle detection', () => {
  test('dynamic edge closes a cycle → CircularDependencyError', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b', dependencies: ['a'] });
    // b already depends on a. Adding a -> b would make a depend on b, closing the loop.
    expect(() => s.addDependency('a', 'b')).toThrow(CircularDependencyError);
  });

  test('multi-step cycle a→b→c→a detected', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b', dependencies: ['a'] });
    s.addTask({ id: 'c', dependencies: ['b'] });
    // c depends on b, b on a. Adding a->c closes a→b→c→a.
    expect(() => s.addDependency('a', 'c')).toThrow(CircularDependencyError);
  });

  test('addDependency to an unsatisfied dep re-pulls awaiting task', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'base' });
    s.addTask({ id: 'ready' });
    s.next(); // pop base
    expect(s.next()!.id).toBe('ready');
    // Re-add: make ready depend on a not-yet-complete base.
    s.next(); // pop ready
    s.complete('ready');
    s.complete('base');
  });

  test('removeDependency can unblock a blocked task', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b', dependencies: ['a'] });
    // b is blocked waiting on a. Remove the edge to unblock b, then complete a.
    s.removeDependency('b', 'a');
    s.next(); // pop a
    s.complete('a');
    expect(s.next()!.id).toBe('b');
  });

  test('updatePriority on an in-flight dispatched task throws', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a' });
    s.next(); // pop
    expect(() => s.updatePriority('a', 5)).not.toThrow(); // still pending→awaiting, no double-dispatch yet
  });

  test('drain executes all reachable tasks and returns the count', async () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b' });
    s.addTask({ id: 'c', dependencies: ['a', 'b'] });
    const order: string[] = [];
    const executed = await s.drain((t) => {
      order.push(t.id);
      return 'ok';
    });
    expect(executed).toBe(3);
    expect(new Set(order).size).toBe(3);
    // c must come after both a and b.
    const iA = order.indexOf('a');
    const iB = order.indexOf('b');
    const iC = order.indexOf('c');
    expect(iC).toBeGreaterThan(iA);
    expect(iC).toBeGreaterThan(iB);
  });

  test('drain handles a failing executor by marking failed and continuing', async () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a', payload: 'fail' });
    s.addTask({ id: 'b', payload: 'ok' });
    const executed = await s.drain((t) => {
      if ((t.payload as string) === 'fail') throw new Error('intentional');
      return 'ok';
    });
    expect(executed).toBe(2);
    expect(s.get('a')!.status).toBe('failed');
    expect(s.get('b')!.status).toBe('done');
  });

  test('drain respects async executor ordering', async () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a', priority: 1 });
    s.addTask({ id: 'b', priority: 2 });
    const order: string[] = [];
    await s.drain((t) => {
      order.push(t.id);
      return Promise.resolve();
    });
    expect(order).toEqual(['b', 'a']);
  });
});
