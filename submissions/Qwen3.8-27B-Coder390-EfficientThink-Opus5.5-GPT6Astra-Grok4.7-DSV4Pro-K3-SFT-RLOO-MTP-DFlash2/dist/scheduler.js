"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecutorError = exports.TaskScheduler = void 0;
exports.readySetCompare = readySetCompare;
const clock_1 = require("./clock");
const heap_1 = require("./heap");
const errors_1 = require("./errors");
Object.defineProperty(exports, "ExecutorError", { enumerable: true, get: function () { return errors_1.ExecutorError; } });
/**
 * Sort key for the ready set. Ordering is a total order:
 *   1. earlier `executeAt` first (timestamp dominance),
 *   2. then higher `priority` first,
 *   3. then earlier `createdAt` first (stable FIFO among full ties),
 *   4. then lexicographic `id` (final deterministic tie-break).
 * The comparator returns <0 when `a` should run before `b`.
 */
function readySetCompare(a, b) {
    if (a.executeAt !== b.executeAt)
        return a.executeAt - b.executeAt;
    if (a.priority !== b.priority)
        return b.priority - a.priority; // higher first
    if (a.createdAt !== b.createdAt)
        return a.createdAt - b.createdAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
/**
 * In-memory DAG task scheduler.
 *
 * Ready-set invariant: `ready` holds EVERY task whose status is `awaiting`
 * (all dependencies satisfied), whether or not its `executeAt` has arrived.
 * `next()` gates on due-ness: it peeks the min-executeAt entry and, because the
 * heap orders by executeAt first, if that earliest entry is not yet due then
 * nothing is due, so it returns null. A task therefore re-emerges on its own
 * when the clock crosses its `executeAt`, and `updateExecuteAt`/`updatePriority`
 * re-key it in O(log n) — no separate re-queue step is needed.
 *
 * Pull model: `addTask(...)` registers tasks and dependency edges. `next()`
 * pops the single next-executable task in O(log n). The caller runs it and
 * calls `complete(id)` / `fail(id, error)` / `cancel(id)` to drive
 * propagation to dependents. `drain(executor)` is a convenience async loop.
 *
 * See README.md for architecture, complexity, and the 1M-task discussion.
 */
class TaskScheduler {
    tasks = new Map();
    /** id -> ids this task directly depends on. */
    deps = new Map();
    /** id -> ids that directly depend on this task (reverse edges). */
    dependents = new Map();
    /** The ready set: all awaiting tasks (due or not). */
    ready = new heap_1.PriorityQueue(readySetCompare);
    /** Popped but not yet completed — guards against double-service. */
    dispatched = new Set();
    clock;
    idCounter = 0;
    constructor(clock = new clock_1.SystemClock()) {
        this.clock = clock;
    }
    /** Number of tasks in every state. */
    get size() {
        return this.tasks.size;
    }
    /** Number of tasks currently in the ready set (all awaiting tasks). */
    get readyCount() {
        return this.ready.size;
    }
    statusCounts() {
        const out = {
            pending: 0,
            awaiting: 0,
            done: 0,
            cancelled: 0,
            failed: 0,
        };
        for (const t of this.tasks.values())
            out[t.status]++;
        return out;
    }
    has(id) {
        return this.tasks.has(id);
    }
    get(id) {
        return this.tasks.get(id);
    }
    /**
     * Add a task. Validates dependencies, rejects self/circular/unknown deps,
     * and immediately inserts into the ready set if the task has no
     * (or all already-satisfied) dependencies. Returns the created task.
     *
     * @throws DuplicateTaskError, SelfDependencyError, InvalidDependencyError.
     */
    addTask(input) {
        if (input.id !== undefined && this.tasks.has(input.id)) {
            throw new errors_1.DuplicateTaskError(input.id);
        }
        const id = input.id ?? this.generateId();
        const now = this.clock.now();
        const deps = this.normalizeDeps(id, input.dependencies ?? []);
        const task = {
            id,
            name: input.name ?? id,
            status: 'pending',
            priority: input.priority ?? 0,
            executeAt: input.executeAt ?? now,
            dependencies: [...deps],
            satisfiedDependencies: 0,
            unsatisfied: deps.size,
            createdAt: now,
            awaitingSince: null,
            startedAt: null,
            finishedAt: null,
        };
        if (input.payload !== undefined)
            task.payload = input.payload;
        this.tasks.set(id, task);
        this.deps.set(id, deps);
        this.dependents.set(id, new Set());
        for (const dep of deps) {
            this.dependents.get(dep).add(id);
        }
        // A dep is satisfied iff done or cancelled (see design decision: cancel is
        // not failure, so its dependents are still runnable).
        for (const dep of deps) {
            const d = this.tasks.get(dep);
            if (d.status === 'done' || d.status === 'cancelled') {
                this.satisfy(task, dep);
            }
        }
        this.maybeReady(task);
        return task;
    }
    /**
     * Return (and pop) the next executable task, or null if none. A task is
     * executable when it is awaiting AND `executeAt <= clock.now()`. Because the
     * ready heap orders by executeAt first, the min entry is the earliest-due
     * awaiting task: if it is not yet due, nothing is. O(log n).
     */
    next() {
        if (this.ready.size === 0)
            return null;
        const top = this.ready.peek();
        if (!top || top.value.executeAt > this.clock.now()) {
            return null;
        }
        const entry = this.ready.pop();
        const t = entry.value;
        if (this.dispatched.has(t.id)) {
            throw new errors_1.DoubleDispatchError(t.id);
        }
        this.dispatched.add(t.id);
        if (t.startedAt === null)
            t.startedAt = this.clock.now();
        return t;
    }
    /**
     * Mark a task completed successfully and propagate readiness to its
     * dependents. Idempotent on terminal states. O(1 + out-degree).
     */
    complete(id) {
        const t = this.require(id);
        if (t.status === 'done' || t.status === 'cancelled' || t.status === 'failed')
            return;
        t.status = 'done';
        t.finishedAt = this.clock.now();
        this.removeFromReady(id);
        this.dispatched.delete(id);
        this.onSatisfied(t);
    }
    /** Mark a task as failed. Dependents are NOT satisfied (they stay pending). */
    fail(id, error) {
        const t = this.require(id);
        if (t.status === 'done' || t.status === 'cancelled' || t.status === 'failed')
            return;
        t.status = 'failed';
        t.finishedAt = this.clock.now();
        t.error = error instanceof Error ? error.message : String(error);
        this.removeFromReady(id);
        this.dispatched.delete(id);
    }
    /**
     * Cancel a task. Cancelling a pending/awaiting task satisfies its dependents
     * (design decision: a cancelled precondition is not a failed one). Cancelling
     * an in-flight (dispatched) task is rejected.
     */
    cancel(id) {
        const t = this.require(id);
        if (t.status === 'done' || t.status === 'failed' || t.status === 'cancelled')
            return;
        if (this.dispatched.has(id)) {
            throw new errors_1.InvalidUpdateError(`Cannot cancel task "${id}": it is currently executing.`);
        }
        t.status = 'cancelled';
        t.finishedAt = this.clock.now();
        this.removeFromReady(id);
        this.onSatisfied(t);
    }
    /** Update a task's priority; re-keys the ready entry. O(log n). */
    updatePriority(id, priority) {
        const t = this.require(id);
        if (t.status === 'done' || t.status === 'cancelled' || t.status === 'failed') {
            throw new errors_1.InvalidUpdateError(`Cannot update a terminal task "${id}".`);
        }
        t.priority = priority;
        this.rekey(id);
    }
    /** Update a task's executeAt; re-keys the ready entry. O(log n). */
    updateExecuteAt(id, executeAt) {
        const t = this.require(id);
        if (t.status === 'done' || t.status === 'cancelled' || t.status === 'failed') {
            throw new errors_1.InvalidUpdateError(`Cannot update a terminal task "${id}".`);
        }
        if (executeAt < 0)
            throw new errors_1.InvalidUpdateError('executeAt must be >= 0.');
        t.executeAt = executeAt;
        this.rekey(id);
    }
    /**
     * Add a dependency edge "id depends on dep". Runs an incremental cycle check.
     * If `dep` is already satisfied the task's unsatisfied count is unchanged;
     * otherwise it increments and, if the task was awaiting, it is re-pulled as
     * pending. O(V + E) worst case for the reachability check.
     */
    addDependency(id, dep) {
        const t = this.require(id);
        if (dep === id)
            throw new errors_1.SelfDependencyError(id);
        if (!this.tasks.has(dep))
            throw new errors_1.InvalidDependencyError(id, dep);
        if (t.status === 'done' || t.status === 'cancelled' || t.status === 'failed') {
            throw new errors_1.InvalidUpdateError(`Cannot add a dependency to terminal task "${id}".`);
        }
        if (this.deps.get(id).has(dep))
            return; // already present
        // Cycle check: id depends on dep closes a cycle iff id is reachable from
        // dep via existing "depends on" edges.
        if (this.isReachable(dep, id)) {
            throw new errors_1.CircularDependencyError(this.extractCycle(dep, id));
        }
        this.deps.get(id).add(dep);
        this.dependents.get(dep).add(id);
        const d = this.tasks.get(dep);
        if (!(d.status === 'done' || d.status === 'cancelled')) {
            t.unsatisfied += 1;
        }
        if (t.status === 'awaiting') {
            this.removeFromReady(id);
            t.status = 'pending';
            this.maybeReady(t);
        }
    }
    /**
     * Remove a dependency edge. Removing an already-satisfied dependency is a
     * no-op on readiness; removing an unsatisfied one may unblock the task.
     */
    removeDependency(id, dep) {
        const t = this.require(id);
        if (t.status === 'done' || t.status === 'cancelled' || t.status === 'failed') {
            throw new errors_1.InvalidUpdateError(`Cannot remove a dependency from terminal task "${id}".`);
        }
        if (!this.deps.get(id).has(dep))
            return;
        this.deps.get(id).delete(dep);
        this.dependents.get(dep).delete(id);
        const d = this.tasks.get(dep);
        if (!(d.status === 'done' || d.status === 'cancelled') && t.unsatisfied > 0) {
            t.unsatisfied -= 1;
            t.satisfiedDependencies = t.dependencies.length - t.unsatisfied;
        }
        this.maybeReady(t);
    }
    /**
     * Run every reachable task to completion using `executor`, then return the
     * count executed. Resolves tasks in ready-set order, awaiting each executor
     * result. Failures are recorded but do not stop the drain.
     */
    async drain(executor) {
        let executed = 0;
        for (;;) {
            const t = this.next();
            if (t === null)
                break;
            try {
                await executor(t, t.payload);
                this.complete(t.id);
            }
            catch (err) {
                this.fail(t.id, err);
            }
            executed += 1;
        }
        return executed;
    }
    /** Run up to `count` tasks (or until none ready), executing each. */
    async run(executor, count) {
        let executed = 0;
        while (executed < count) {
            const t = this.next();
            if (t === null)
                break;
            try {
                await executor(t, t.payload);
                this.complete(t.id);
            }
            catch (err) {
                this.fail(t.id, err);
            }
            executed += 1;
        }
        return executed;
    }
    /** Reset the scheduler (drops all state). For tests/reuse only. */
    clear() {
        this.tasks.clear();
        this.deps.clear();
        this.dependents.clear();
        this.ready.clear();
        this.dispatched.clear();
    }
    // ── internal ──────────────────────────────────────────────────────────
    /**
     * Flip pending -> awaiting when the last unsatisfied dep clears, and keep
     * the task in the ready set while awaiting. Idempotent: re-inserting an
     * already-present awaiting task is harmless (the heap dedupes by key).
     * Never inserts a task that is already dispatched (in flight).
     */
    maybeReady(t) {
        if (t.unsatisfied === 0 && t.status === 'pending') {
            t.status = 'awaiting';
            if (t.awaitingSince === null)
                t.awaitingSince = this.clock.now();
        }
        if (t.status === 'awaiting' && !this.dispatched.has(t.id)) {
            this.ready.insert(t.id, t);
        }
    }
    /** Re-key (remove+reinsert) the ready entry for id if it is awaiting. */
    rekey(id) {
        const t = this.tasks.get(id);
        if (t.status !== 'awaiting')
            return;
        this.removeFromReady(id);
        if (!this.dispatched.has(id))
            this.ready.insert(id, t);
    }
    /** Drop id from the ready set if present. O(log n), no-op if absent. */
    removeFromReady(id) {
        this.ready.remove(id);
    }
    /** Mark one dependency of t as satisfied (decrement unsatisfied). */
    satisfy(t, dep) {
        t.unsatisfied = Math.max(0, t.unsatisfied - 1);
        t.satisfiedDependencies = t.dependencies.length - t.unsatisfied;
    }
    /** After a task reaches a satisfied state, wake any dependents. */
    onSatisfied(t) {
        const out = this.dependents.get(t.id);
        if (!out)
            return;
        for (const dependentId of out) {
            const d = this.tasks.get(dependentId);
            if (!d)
                continue;
            if (d.status === 'pending' || d.status === 'awaiting') {
                this.satisfy(d, t.id);
                this.maybeReady(d);
            }
        }
    }
    /** BFS in "depends on" direction from `from`, reporting reachability to `to`. */
    isReachable(from, to) {
        if (from === to)
            return true;
        const seen = new Set([from]);
        const stack = [from];
        while (stack.length > 0) {
            const cur = stack.pop();
            const nexts = this.deps.get(cur);
            if (!nexts)
                continue;
            for (const nx of nexts) {
                if (nx === to)
                    return true;
                if (!seen.has(nx)) {
                    seen.add(nx);
                    stack.push(nx);
                }
            }
        }
        return false;
    }
    /** Reconstruct one cycle path for a clear error message.
     *
     * Called with (from=dep, to=id) when `addDependency(id, dep)` would close
     * a cycle. Returns a vertex list [id, dep, …, id] (start == end) such that
     * consecutive pairs describe "X depends on Y".
     */
    extractCycle(from, to) {
        // Walk parent pointers from `to` back to `from`, recording the path.
        const parent = new Map();
        const seen = new Set([from]);
        const stack = [from];
        let found = false;
        while (stack.length > 0) {
            const cur = stack.pop();
            const nexts = this.deps.get(cur) ?? new Set();
            for (const nx of nexts) {
                if (seen.has(nx))
                    continue;
                seen.add(nx);
                parent.set(nx, cur);
                if (nx === to) {
                    found = true;
                    stack.length = 0;
                    break;
                }
                stack.push(nx);
            }
        }
        if (!found)
            return [to, from, to];
        // path = [to, …, from] (parent-pointer walk). Reverse to get [from, …, to].
        // Cycle = [to, from, …, to]: the new edge `to→from` plus the existing path `from→…→to`.
        const path = [to];
        let cur = to;
        while (cur !== from) {
            const p = parent.get(cur);
            if (!p)
                break;
            path.push(p);
            cur = p;
        }
        path.reverse(); // [from, …, to]
        return [to, ...path]; // [to, from, …, to] — start == end
    }
    require(id) {
        const t = this.tasks.get(id);
        if (!t)
            throw new errors_1.UnknownTaskError(id);
        return t;
    }
    /** De-dupe dependency ids, preserving order. */
    normalizeDeps(id, raw) {
        const out = new Set();
        for (const dep of raw) {
            if (dep === id)
                throw new errors_1.SelfDependencyError(id);
            if (!this.tasks.has(dep))
                throw new errors_1.InvalidDependencyError(id, dep);
            out.add(dep);
        }
        return out;
    }
    generateId() {
        this.idCounter += 1;
        return `task_${this.idCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }
}
exports.TaskScheduler = TaskScheduler;
//# sourceMappingURL=scheduler.js.map