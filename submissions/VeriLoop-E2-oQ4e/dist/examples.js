"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Practical usage examples for the TaskScheduler.
 *
 * These are runnable with `node dist/examples.js` after `npm run build`.
 * They demonstrate the full workflow: adding tasks, claiming/executing them,
 * dynamic updates, and error handling.
 *
 * The examples use the compiled output, so run:
 *   npm run build && node dist/examples.js
 */
const index_js_1 = require("./index.js");
function log(msg) {
    console.log(msg);
}
// ---------------------------------------------------------------------------
// Example 1: Basic priority-ordered execution
// ---------------------------------------------------------------------------
function exampleBasic() {
    log('\n=== Example 1: Basic priority-ordered execution ===');
    const s = new index_js_1.TaskScheduler();
    s.add({ id: 'low', priority: 1, payload: 'low priority task' });
    s.add({ id: 'high', priority: 10, payload: 'high priority task' });
    s.add({ id: 'mid', priority: 5, payload: 'medium priority task' });
    log(`Next executable: ${s.peekNext().id}`); // 'high' (priority 10)
    // Execute all tasks in priority order
    for (;;) {
        const task = s.execute();
        if (!task)
            break;
        log(`  Executed: ${task.id} (priority=${task.priority}) — ${task.payload}`);
    }
    log(`  Completed: ${s.completedCount} tasks`);
}
// ---------------------------------------------------------------------------
// Example 2: Dependency-ordered execution
// ---------------------------------------------------------------------------
function exampleDependencies() {
    log('\n=== Example 2: Dependency-ordered execution ===');
    const s = new index_js_1.TaskScheduler();
    // A pipeline: fetch → parse → transform → store
    s.add({ id: 'fetch', priority: 0 });
    s.add({ id: 'parse', dependsOn: ['fetch'], priority: 0 });
    s.add({ id: 'transform', dependsOn: ['parse'], priority: 0 });
    s.add({ id: 'store', dependsOn: ['transform'], priority: 0 });
    log('Next executable: ' + s.peekNext().id); // 'fetch' (only task with no deps)
    // Execute the pipeline
    let task;
    const order = [];
    while ((task = s.execute())) {
        order.push(task.id);
    }
    log(`  Execution order: ${order.join(' → ')}`);
    log(`  Completed: ${s.completedCount} tasks`);
}
// ---------------------------------------------------------------------------
// Example 3: Fan-in (reduce pattern)
// ---------------------------------------------------------------------------
function exampleFanIn() {
    log('\n=== Example 3: Fan-in (reduce pattern) ===');
    const s = new index_js_1.TaskScheduler();
    // 5 independent sources feed into 1 aggregator
    const sources = [];
    for (let i = 0; i < 5; i++) {
        const id = `source-${i}`;
        sources.push(id);
        s.add({ id, priority: 0, payload: `source ${i}` });
    }
    s.add({ id: 'aggregate', dependsOn: sources, priority: 0 });
    log(`  Aggregator unmet deps: ${s.get('aggregate').unmetDependencies.length}`);
    // Execute: 5 sources in any order, then the aggregator
    let executed = 0;
    for (;;) {
        const t = s.execute();
        if (!t)
            break;
        executed++;
        log(`    Executed: ${t.id}`);
    }
    log(`  Completed: ${executed} tasks (5 sources + 1 aggregator)`);
}
// ---------------------------------------------------------------------------
// Example 4: Dynamic updates (priority changes while tasks are queued)
// ---------------------------------------------------------------------------
function exampleDynamicUpdates() {
    log('\n=== Example 4: Dynamic updates ===');
    const s = new index_js_1.TaskScheduler();
    s.add({ id: 'a', priority: 1 });
    s.add({ id: 'b', priority: 2 });
    s.add({ id: 'c', priority: 3 });
    log(`  Before update, next executable: ${s.peekNext().id}`); // 'c' (priority 3)
    // 'a' becomes urgent
    s.update('a', { priority: 10 });
    log(`  After bumping 'a' to priority 10, next executable: ${s.peekNext().id}`); // 'a'
    // Execute all
    for (;;) {
        const t = s.execute();
        if (!t)
            break;
    }
    log(`  Completed: ${s.completedCount} tasks`);
}
// ---------------------------------------------------------------------------
// Example 5: Execution timestamps (scheduled tasks)
// ---------------------------------------------------------------------------
function exampleScheduled() {
    log('\n=== Example 5: Execution timestamps ===');
    // Use a fake clock for determinism
    let now = 0;
    const s = new index_js_1.TaskScheduler({ now: () => now });
    s.add({ id: 'immediate', priority: 0 });
    s.add({ id: 'in-100ms', scheduledAt: 100, priority: 0 });
    s.add({ id: 'in-200ms', scheduledAt: 200, priority: 0 });
    log(`  At t=${now}, next executable: ${s.peekNext()?.id ?? 'none'}`); // 'immediate'
    s.execute();
    now = 50;
    log(`  At t=${now}, next executable: ${s.peekNext()?.id ?? 'none'}`); // none (deferred)
    now = 100;
    log(`  At t=${now}, next executable: ${s.peekNext()?.id ?? 'none'}`); // 'in-100ms'
    s.execute();
    now = 200;
    log(`  At t=${now}, next executable: ${s.peekNext()?.id ?? 'none'}`); // 'in-200ms'
    s.execute();
    log(`  Completed: ${s.completedCount} tasks`);
}
// ---------------------------------------------------------------------------
// Example 6: Execution failure and cascade
// ---------------------------------------------------------------------------
function exampleFailure() {
    log('\n=== Example 6: Execution failure and cascade ===');
    const s = new index_js_1.TaskScheduler();
    s.add({ id: 'source', priority: 10 }); // higher priority so claim() picks it first
    s.add({ id: 'transform', dependsOn: ['source'], priority: 10 });
    s.add({ id: 'store', dependsOn: ['transform'], priority: 10 });
    s.add({ id: 'independent', priority: 0 }); // lower priority; unaffected by failure
    // Claim and fail 'source'
    const src = s.claim(); // source (priority 10, highest)
    log(`  Claimed: ${src.id}`);
    s.complete(src.id, false); // fail
    log(`  'transform' still live? ${s.has('transform')}`); // false (cascade-failed)
    log(`  'store' still live? ${s.has('store')}`); // false (transitively cascade-failed)
    log(`  'independent' still live? ${s.has('independent')}`); // true (unaffected)
    // Complete the independent task
    s.execute();
    log(`  Completed: ${s.completedCount}, Failed: ${s.failedCount}`);
}
// ---------------------------------------------------------------------------
// Example 7: Cycle detection
// ---------------------------------------------------------------------------
function exampleCycle() {
    log('\n=== Example 7: Cycle detection ===');
    const s = new index_js_1.TaskScheduler();
    s.add({ id: 'a', dependsOn: ['b'] }); // a → b (forward reference)
    try {
        s.add({ id: 'b', dependsOn: ['a'] }); // b → a closes the cycle
        log('  ERROR: cycle not detected!');
    }
    catch (e) {
        if (e instanceof index_js_1.CycleError) {
            log(`  Cycle detected: ${e.path.join(' → ')}`);
        }
    }
    // 'a' is still live and uncorrupted
    log(`  'a' still live after failed add? ${s.has('a')}`);
    log(`  Scheduler size: ${s.size}`);
}
// ---------------------------------------------------------------------------
// Example 8: Forward references (incremental graph building)
// ---------------------------------------------------------------------------
function exampleForwardReferences() {
    log('\n=== Example 8: Forward references ===');
    const s = new index_js_1.TaskScheduler();
    // Add tasks in an order where a task references a not-yet-added dependency
    s.add({ id: 'transform', dependsOn: ['parse'] }); // references 'parse' (not yet added)
    s.add({ id: 'store', dependsOn: ['transform'] }); // references 'transform' (added)
    s.add({ id: 'parse', dependsOn: ['fetch'] }); // references 'fetch' (not yet added)
    s.add({ id: 'fetch' }); // no deps
    log(`  Scheduler size: ${s.size}`);
    // Execute: fetch → parse → transform → store
    const order = [];
    let t;
    while ((t = s.execute())) {
        order.push(t.id);
    }
    log(`  Execution order: ${order.join(' → ')}`);
    log(`  Completed: ${s.completedCount} tasks`);
}
// ---------------------------------------------------------------------------
// Run all examples
// ---------------------------------------------------------------------------
exampleBasic();
exampleDependencies();
exampleFanIn();
exampleDynamicUpdates();
exampleScheduled();
exampleFailure();
exampleCycle();
exampleForwardReferences();
log('\n=== All examples complete ===');
//# sourceMappingURL=examples.js.map