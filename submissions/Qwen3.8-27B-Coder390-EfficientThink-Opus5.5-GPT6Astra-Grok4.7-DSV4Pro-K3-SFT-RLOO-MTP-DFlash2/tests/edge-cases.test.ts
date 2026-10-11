import { TaskScheduler } from '../src/scheduler';
import { FakeClock } from '../src/clock';
import {
  CircularDependencyError,
  InvalidUpdateError,
  UnknownTaskError,
} from '../src/errors';

const clock = new FakeClock(0);

describe('Edge cases & invariants', () => {
  test('empty scheduler: next() is null, drain() is 0', async () => {
    const s = new TaskScheduler(clock);
    expect(s.next()).toBeNull();
    expect(await s.drain(() => 'ok')).toBe(0);
  });

  test('two tasks with identical (executeAt, priority, createdAt) are still deterministically ordered', () => {
    const s = new TaskScheduler(clock);
    clock.freeze(100);
    s.addTask({ id: 'a', executeAt: 100, priority: 0 });
    s.addTask({ id: 'b', executeAt: 100, priority: 0 });
    // Tie-break is id lexicographic.
    expect(s.next()!.id).toBe('a');
    s.complete('a');
    expect(s.next()!.id).toBe('b');
  });

  test('cancel then fail is impossible (cancel wins and is terminal)', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a' });
    s.cancel('a');
    s.fail('a', new Error('late'));
    expect(s.get('a')!.status).toBe('cancelled');
  });

  test('fail then complete is impossible (fail is terminal)', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a' });
    s.fail('a', new Error('x'));
    s.complete('a');
    expect(s.get('a')!.status).toBe('failed');
  });

  test('removeDependency on a satisfied dep does not unblock readiness', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'done', executeAt: clock.now() - 10 });
    s.next(); // pop done
    s.complete('done');
    // Now add a task depending on the already-done task. It should immediately be awaiting.
    s.addTask({ id: 'dependent', dependencies: ['done'] });
    // Removing the (already-satisfied) dep should not regress the dependent to pending.
    s.removeDependency('dependent', 'done');
    expect(s.next()!.id).toBe('dependent');
  });

  test('cancel an in-flight (dispatched) task throws InvalidUpdateError', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a' });
    s.next(); // dispatch
    expect(() => s.cancel('a')).toThrow(InvalidUpdateError);
  });

  test('next() after all tasks dispatched is null even if not completed', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a' });
    s.next();
    expect(s.next()).toBeNull();
  });

  test('extractCycle produces a readable cycle for an error message', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b', dependencies: ['a'] });
    s.addTask({ id: 'c', dependencies: ['b'] });
    let err: unknown;
    try {
      s.addDependency('a', 'c');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CircularDependencyError);
    const msg = (err as Error).message;
    // Cycle is a -> c (new edge) -> b -> a (existing path). Order must close the loop.
    expect(msg).toContain('a -> c -> b -> a');
  });

  test('negative executeAt is rejected by updateExecuteAt', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a' });
    expect(() => s.updateExecuteAt('a', -5)).toThrow(InvalidUpdateError);
  });

  test('updateExecuteAt to a past time immediately re-queues the task', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a', executeAt: clock.now() + 1000 });
    expect(s.next()).toBeNull();
    s.updateExecuteAt('a', clock.now());
    expect(s.next()!.id).toBe('a');
  });

  test('removing the only dep of a pending task makes it immediately awaiting', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b', dependencies: ['a'] });
    // While b depends on a (not yet done), b is pending. Remove the edge,
    // complete a, then b must become runnable.
    s.removeDependency('b', 'a');
    s.next(); // pop a
    s.complete('a');
    expect(s.next()!.id).toBe('b');
  });

  test('get() on an unknown id returns undefined; require() throws UnknownTaskError', () => {
    const s = new TaskScheduler(clock);
    expect(s.get('ghost')).toBeUndefined();
    expect(() => s.complete('ghost')).toThrow(UnknownTaskError);
  });

  test('clear() resets everything for reuse', () => {
    const s = new TaskScheduler(clock);
    s.addTask({ id: 'a' });
    s.addTask({ id: 'b' });
    s.clear();
    expect(s.size).toBe(0);
    expect(s.next()).toBeNull();
    s.addTask({ id: 'c' });
    expect(s.size).toBe(1);
  });
});
