/**
 * End-to-end demo of the TaskScheduler: priorities, execution timestamps,
 * dependencies, dynamic updates, cycle detection, and O(log n) retrieval.
 * Uses FakeClock so the execution timestamps are deterministic.
 *
 * Run: npm run demo
 */
import { TaskScheduler } from '../src/scheduler';
import { FakeClock } from '../src/clock';
import { CircularDependencyError } from '../src/errors';

const clock = new FakeClock(1000);
const s = new TaskScheduler(clock);

console.log('── Build a small DAG with priorities and timestamps ──');
// Two roots: 'data' is due immediately, 'model' is 100ms in the future.
s.addTask({ id: 'data',   priority: 1, executeAt: clock.now() });        // due 1000
s.addTask({ id: 'model',  priority: 5, executeAt: clock.now() + 100 });  // due 1100
s.addTask({ id: 'report', priority: 3, dependencies: ['data', 'model'] });
s.addTask({ id: 'sanity', priority: 9, dependencies: ['data'] });

// The ready set orders by executeAt first, then priority. At t=1000 only
// 'data' (due 1000) is a due root; 'model' (due 1100) is still in the future.
console.log('next() at t=1000:', s.next()!.id, '(only due root; model is 100ms away)');
s.complete('data');

// Completing 'data' satisfies its dependent 'sanity' immediately, so it is now
// runnable and due (t=1000) and pops before 'model' (still not due).
console.log('next() after data (sanity became due):', s.next()!.id);
s.complete('sanity');

// Now the only awaiting task is 'model', but its timestamp (1100) has not
// arrived, so next() correctly returns null until the clock advances.
console.log('next() at t=1000 (model not yet due):', s.next());
clock.advance(100);
console.log('next() at t=1100:', s.next()!.id, '(model now due, high priority)');
s.complete('model');

// Both prerequisites of 'report' are now satisfied.
console.log('next() (report, both deps done):', s.next()!.id);
s.complete('report');
console.log('all tasks completed:', s.next() === null);

console.log('\n── Dynamic edge addition triggers cycle detection ──');
const s2 = new TaskScheduler(clock);
s2.addTask({ id: 'a' });
s2.addTask({ id: 'b', dependencies: ['a'] });
s2.addTask({ id: 'c', dependencies: ['b'] });
console.log('a, b, c registered (a <- b <- c).');
try {
  s2.addDependency('a', 'c');
  console.log('UNEXPECTED: no cycle detected');
} catch (e) {
  if (e instanceof CircularDependencyError) {
    console.log('Caught cycle:', e.message);
  } else {
    throw e;
  }
}

console.log('\n── Cancel semantics: a cancelled precondition still satisfies dependents ──');
const s3 = new TaskScheduler(clock);
s3.addTask({ id: 'skip' });
s3.addTask({ id: 'downstream', dependencies: ['skip'] });
s3.cancel('skip');
console.log('after cancel(skip), next():', s3.next()!.id);

console.log('\n── drain() runs a diamond to completion ──');
const s4 = new TaskScheduler(clock);
s4.addTask({ id: 'l' });
s4.addTask({ id: 'm' });
s4.addTask({ id: 'top', dependencies: ['l', 'm'], priority: 10 });
const order: string[] = [];
s4.drain((t) => { order.push(t.id); return 'ok'; })
  .then((n) => {
    console.log(`drain ran ${n} tasks in order:`, order.join(' -> '));
    console.log('\nAll demos completed.');
  })
  .catch((err) => { console.error(err); process.exit(1); });
