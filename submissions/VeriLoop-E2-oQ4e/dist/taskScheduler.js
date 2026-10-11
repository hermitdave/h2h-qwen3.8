"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskScheduler = exports.InvalidStateError = exports.TaskNotFoundError = exports.CycleError = exports.SelfDependencyError = exports.DuplicateTaskError = void 0;
/**
 * TaskScheduler
 * -------------
 * A production-grade, in-memory, dependency-aware task scheduler.
 *
 * Supports:
 *   - 1,000,000+ concurrent tasks
 *   - numeric priorities (higher = more urgent)
 *   - execution timestamps (epoch ms; tasks deferred until their time)
 *   - dependency tracking (DAG, forward references allowed)
 *   - dynamic updates (priority / scheduledAt changes on live tasks)
 *   - cycle detection (rejected at insertion)
 *   - O(1) next-executable retrieval (amortised O(log n) on promotion)
 *   - cascade-fail on removal and on dependency failure
 *
 * See README.md for the full architecture, data-structure and complexity
 * write-up.
 */
const types_1 = require("./types");
const minheap_1 = require("./minheap");
// ---- errors ------------------------------------------------------------
class DuplicateTaskError extends Error {
    constructor(id) {
        super(`Task '${id}' already exists`);
        this.name = 'DuplicateTaskError';
    }
}
exports.DuplicateTaskError = DuplicateTaskError;
class SelfDependencyError extends Error {
    constructor(id) {
        super(`Task '${id}' depends on itself`);
        this.name = 'SelfDependencyError';
    }
}
exports.SelfDependencyError = SelfDependencyError;
class CycleError extends Error {
    constructor(path) {
        super(`Dependency cycle detected: ${path.join(' -> ')}`);
        this.name = 'CycleError';
        this.path = path;
    }
}
exports.CycleError = CycleError;
class TaskNotFoundError extends Error {
    constructor(id) {
        super(`Task '${id}' not found`);
        this.name = 'TaskNotFoundError';
    }
}
exports.TaskNotFoundError = TaskNotFoundError;
class InvalidStateError extends Error {
    constructor(id, state, required) {
        super(`Task '${id}' is '${state}' but requires '${required}'`);
        this.name = 'InvalidStateError';
    }
}
exports.InvalidStateError = InvalidStateError;
// ---- scheduler ---------------------------------------------------------
class TaskScheduler {
    constructor(options = {}) {
        /** Task lookup by id.  Only LIVE tasks (PENDING / RUNNING) are present. */
        this.tasks = new Map();
        /** Forward references: referenced-id → set of added nodes that depend on it.
         *  Non-empty only for incrementally-built graphs.  Resolved (and cleared)
         *  when the referenced node is added. */
        this.forwardRefs = new Map();
        /** Metrics for observability. */
        this._completedCount = 0;
        this._failedCount = 0;
        this._addedCount = 0;
        this.clock = options.now ?? Date.now;
        // run-heap: highest priority first; ties by earlier scheduledAt; ties by id.
        this.runHeap = new minheap_1.MinHeap((a, b) => {
            if (a.priority !== b.priority)
                return b.priority - a.priority; // desc
            if (a.scheduledAt !== b.scheduledAt)
                return a.scheduledAt - b.scheduledAt; // asc
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // stable
        });
        // deferred-heap: earliest scheduledAt first; ties by higher priority; ties by id.
        this.deferredHeap = new minheap_1.MinHeap((a, b) => {
            if (a.scheduledAt !== b.scheduledAt)
                return a.scheduledAt - b.scheduledAt; // asc
            if (a.priority !== b.priority)
                return b.priority - a.priority; // desc
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // stable
        });
    }
    // ---- metrics ---------------------------------------------------------
    /** Number of live tasks (PENDING or RUNNING). */
    get size() {
        return this.tasks.size;
    }
    /** Total tasks added since construction (includes completed/failed/removed). */
    get addedCount() {
        return this._addedCount;
    }
    /** Tasks completed successfully. */
    get completedCount() {
        return this._completedCount;
    }
    /** Tasks failed (direct failure or cascade). */
    get failedCount() {
        return this._failedCount;
    }
    // ---- lifecycle -------------------------------------------------------
    /**
     * Add a task.
     *
     * @throws DuplicateTaskError   if `task.id` already exists.
     * @throws SelfDependencyError  if `task` depends on itself.
     * @throws CycleError           if adding `task` closes a dependency cycle.
     *
     * Complexity: O(|dependsOn|) typical; O(V+E) worst case, only when the task
     * is the endpoint of a forward-reference cycle (rare).  Forward references
     * are the ONLY way a cycle can form, so cycle detection is O(1) for the
     * overwhelmingly common case where dependencies are added before their
     * dependents.
     */
    add(task) {
        const id = task.id;
        if (this.tasks.has(id))
            throw new DuplicateTaskError(id);
        const deps = task.dependsOn ?? [];
        if (deps.includes(id))
            throw new SelfDependencyError(id);
        // ---- cycle detection (BEFORE any mutation, so no rollback needed) ----
        // A cycle can only be created by forward references: an existing node P
        // that depends on `id` (registered in forwardRefs[id]) combined with a
        // path from `id` back to P through `id`'s own (existing) dependencies.
        // If any such P exists and `id` reaches P, adding `id` closes a cycle:
        //   id → … → P → id   (P → id via forward ref)
        // The cycle path starts and ends at `id`.
        const forwardResolved = this.forwardRefs.get(id); // existing nodes depending on id
        if (forwardResolved) {
            for (const p of forwardResolved) {
                if (this.idReaches(id, deps, p)) {
                    // pathFrom(deps, p) returns the path from some dep of `id` to `p`.
                    // The full cycle is: id → (deps path) → p → id (forward ref).
                    throw new CycleError([id, ...this.pathFrom(deps, p), id]);
                }
            }
        }
        // ---- apply the task --------------------------------------------------
        const internal = {
            task,
            id,
            priority: task.priority ?? 0,
            scheduledAt: task.scheduledAt,
            dependsOn: [...deps], // full list initially; shrinks as deps complete
            dependents: [],
            state: types_1.TaskState.PENDING,
            version: 0,
        };
        this.tasks.set(id, internal);
        this._addedCount++;
        // Resolve each dependency: if it is already COMPLETED it cannot be in the
        // unmet list (but completed tasks are removed from the map, so we check the
        // forwardRefs / live-map).  For each dependency that is NOT yet completed
        // (live and pending, or a forward reference) we register the reverse edge.
        for (const d of deps) {
            const depInternal = this.tasks.get(d);
            if (depInternal) {
                if (depInternal.state === types_1.TaskState.COMPLETED) {
                    // Already satisfied — drop from unmet list.
                    internal.dependsOn.splice(internal.dependsOn.indexOf(d), 1);
                }
                else {
                    // `id` is unblocked when `d` completes.
                    depInternal.dependents.push(id);
                }
            }
            else {
                // Forward reference: `d` does not exist yet.  Register that `id`
                // depends on `d`; resolved when `d` is added.
                let set = this.forwardRefs.get(d);
                if (!set) {
                    set = new Set();
                    this.forwardRefs.set(d, set);
                }
                set.add(id);
            }
        }
        // Resolve forward references pointing AT id: existing nodes added earlier
        // that depend on id.  Register them as dependents so complete(id) unblocks
        // them.  Their unmet lists already include id from their own add-time, so
        // we do NOT touch them here — only the reverse edge matters.
        if (forwardResolved) {
            for (const p of forwardResolved) {
                internal.dependents.push(p);
            }
            this.forwardRefs.delete(id);
        }
        // Schedule if all dependencies are satisfied (unmet list empty).
        if (internal.dependsOn.length === 0) {
            this.scheduleReady(internal);
        }
    }
    /**
     * Remove a task and cascade-fail all transitive dependents (they can never
     * complete without it).  The task and its dependents are deleted from the
     * scheduler; any heap entries they had become stale and are discarded on the
     * next retrieval.
     *
     * @returns true if the task existed and was removed.
     *
     * Complexity: O(subgraph size of dependents) — inherent, since every
     * dependent must be marked failed.
     */
    remove(id) {
        const internal = this.tasks.get(id);
        if (!internal)
            return false;
        internal.state = types_1.TaskState.REMOVED;
        internal.version++; // invalidate any heap entry
        this.tasks.delete(id);
        // Cascade-fail transitive dependents.
        this.cascadeFail(id, internal.dependents);
        return true;
    }
    /**
     * Mark a RUNNING (claimed) task as completed (success) or failed.
     *
     * On success: decrement the in-degree of every dependent; any dependent
     * whose in-degree reaches 0 becomes ready and is scheduled (run-heap if
     * time-eligible, deferred-heap otherwise).
     *
     * On failure: cascade-fail all transitive dependents (they can never run).
     *
     * @returns the number of dependents affected (unblocked on success, failed
     *          on failure).
     *
     * @throws TaskNotFoundError   if `id` does not exist.
     * @throws InvalidStateError   if `id` is not RUNNING (call `claim` first).
     *
     * Complexity: O(out-degree) on success (amortised O(1) per edge over the
     * lifetime of the scheduler); O(dependent-subgraph) on failure.
     */
    complete(id, success = true, now) {
        const internal = this.tasks.get(id);
        if (!internal)
            throw new TaskNotFoundError(id);
        if (internal.state !== types_1.TaskState.RUNNING) {
            throw new InvalidStateError(id, internal.state, types_1.TaskState.RUNNING);
        }
        if (success) {
            internal.state = types_1.TaskState.COMPLETED;
            internal.version++;
            this.tasks.delete(id); // completed tasks leave the live map
            this._completedCount++;
            let unblocked = 0;
            const t = now ?? this.clock();
            for (const depId of internal.dependents) {
                const dep = this.tasks.get(depId);
                if (!dep || dep.state !== types_1.TaskState.PENDING)
                    continue; // only unblock pending
                // Remove the completed dependency from dep's unmet list.
                const at = dep.dependsOn.indexOf(id);
                if (at !== -1)
                    dep.dependsOn.splice(at, 1);
                unblocked++;
                if (dep.dependsOn.length === 0) {
                    this.scheduleReady(dep, t); // ready: push to run- or deferred-heap
                }
            }
            return unblocked;
        }
        else {
            internal.state = types_1.TaskState.FAILED;
            internal.version++;
            this.tasks.delete(id);
            this._failedCount++;
            const failed = this.cascadeFail(id, internal.dependents);
            return failed;
        }
    }
    /**
     * Claim (pop) the next executable task and mark it RUNNING (in-flight).
     *
     * A task is executable when its dependencies are all COMPLETED AND its
     * scheduledAt (if any) has passed.  Among executable tasks, the highest
     * priority is returned first; ties broken by earlier scheduledAt then id.
     *
     * For an external-worker model: claim the task, execute it yourself, then
     * call `complete(id, ok)`.
     *
     * @returns the claimed task, or `undefined` when nothing is executable now.
     *
     * Complexity: O(1) plus amortised O(log n) for promotions and O(k · log n)
     * for discarding k stale entries.
     */
    claim(now) {
        const t = now ?? this.clock();
        this.promote(t); // move time-eligible deferred tasks into the run-heap
        for (;;) {
            const entry = this.runHeap.pop();
            if (!entry)
                return undefined;
            const internal = this.tasks.get(entry.id);
            // Stale: task removed/failed/completed, or re-scheduled with a newer version.
            if (!internal || internal.state !== types_1.TaskState.PENDING || entry.version !== internal.version) {
                continue; // discard, try the next entry
            }
            internal.state = types_1.TaskState.RUNNING; // in-flight
            return internal.task;
        }
    }
    /**
     * Non-destructive preview: which task would `claim` return at time `now`?
     *
     * Stale entries at the top of the run-heap are discarded (they are garbage
     * and safe to drop).  The valid top entry is peeked, not popped, so a
     * subsequent `claim` returns the same task.
     *
     * @returns the next executable task, or `undefined`.
     *
     * Complexity: O(k · log n) for discarding k stale entries + O(1) peek.
     */
    peekNext(now) {
        const t = now ?? this.clock();
        this.promote(t);
        for (;;) {
            const entry = this.runHeap.peek();
            if (!entry)
                return undefined;
            const internal = this.tasks.get(entry.id);
            if (internal && internal.state === types_1.TaskState.PENDING && entry.version === internal.version) {
                return internal.task; // valid — do NOT pop
            }
            this.runHeap.pop(); // stale — discard, check the next entry
        }
    }
    /**
     * Convenience for synchronous in-process execution: claim the next task and
     * immediately complete it successfully (unblocking its dependents).
     *
     * @returns the executed task, or `undefined` when nothing is executable.
     */
    execute(now) {
        const task = this.claim(now);
        if (!task)
            return undefined;
        this.complete(task.id, true, now);
        return task;
    }
    /**
     * Dynamically update a task's priority and/or scheduledAt.
     *
     * If the task is dep-ready (in a heap), a fresh heap entry is pushed with
     * the new values; the old entry becomes stale (version mismatch) and is
     * discarded on the next retrieval.  If the task is not yet dep-ready or is
     * RUNNING, only the stored values change (they take effect when the task
     * becomes ready / on completion respectively).
     *
     * @throws TaskNotFoundError if `id` does not exist.
     *
     * Complexity: O(log n) when the task is dep-ready (heap re-insertion);
     * O(1) otherwise.
     */
    update(id, patch) {
        const internal = this.tasks.get(id);
        if (!internal)
            throw new TaskNotFoundError(id);
        if (patch.priority !== undefined)
            internal.priority = patch.priority;
        if (patch.scheduledAt !== undefined)
            internal.scheduledAt = patch.scheduledAt;
        internal.version++; // invalidate any existing heap entry
        // Re-schedule if the task is dep-ready (in-degree 0, still pending).
        if (internal.state === types_1.TaskState.PENDING && internal.dependsOn.length === 0) {
            this.scheduleReady(internal);
        }
    }
    /**
     * Inspect a task's current status.
     *
     * @returns the status snapshot, or `undefined` if the task does not exist
     *          (or is no longer live — completed/failed/removed).
     */
    get(id) {
        const internal = this.tasks.get(id);
        if (!internal)
            return undefined;
        // `dependsOn` holds exactly the dependencies that are not yet completed
        // (shrink-only, entries removed on completion).  It is the unmet list.
        return {
            id,
            state: internal.state,
            priority: internal.priority,
            scheduledAt: internal.scheduledAt,
            unmetDependencies: internal.dependsOn,
            dependentsCount: internal.dependents.length,
            payload: internal.task.payload,
        };
    }
    /**
     * O(1) check for whether a task is live (PENDING or RUNNING).
     */
    has(id) {
        return this.tasks.has(id);
    }
    // ---- internals -------------------------------------------------------
    /**
     * Schedule a dep-ready task.  Pushes to the run-heap if time-eligible now,
     * else to the deferred-heap (promoted when its scheduledAt arrives).
     */
    scheduleReady(internal, now) {
        if (internal.state !== types_1.TaskState.PENDING)
            return; // already claimed/completed
        const t = now ?? this.clock();
        const entry = {
            id: internal.id,
            priority: internal.priority,
            scheduledAt: internal.scheduledAt ?? 0,
            version: internal.version,
        };
        if (internal.scheduledAt === undefined || internal.scheduledAt <= t) {
            this.runHeap.push(entry); // eligible now
        }
        else {
            this.deferredHeap.push(entry); // deferred until scheduledAt
        }
    }
    /**
     * Move deferred entries with scheduledAt <= now into the run-heap.
     * Stale deferred entries (task removed/updated) are discarded, not moved.
     *
     * This is the timer-wheel promotion step.  Each task is promoted at most
     * once (amortised O(log n)); peekNext in between promotions is O(1).
     */
    promote(now) {
        for (;;) {
            const entry = this.deferredHeap.peek();
            if (!entry || entry.scheduledAt > now)
                break;
            this.deferredHeap.pop(); // remove from deferred-heap
            const internal = this.tasks.get(entry.id);
            if (!internal || internal.state !== types_1.TaskState.PENDING || entry.version !== internal.version) {
                continue; // stale — discard
            }
            this.runHeap.push(entry); // now time-eligible — move to run-heap
        }
    }
    /**
     * Cascade-fail all transitive dependents of a failed/removed task.
     * Uses an explicit stack (not recursion) to avoid stack overflow on deep
     * dependency chains (1M-deep is trivial for a stack, fatal for call frames).
     *
     * @returns the number of dependents failed.
     */
    cascadeFail(fromId, directDependents) {
        let failed = 0;
        const stack = [...directDependents];
        while (stack.length > 0) {
            const depId = stack.pop();
            const dep = this.tasks.get(depId);
            if (!dep || dep.state !== types_1.TaskState.PENDING)
                continue;
            dep.state = types_1.TaskState.FAILED;
            dep.version++;
            this.tasks.delete(depId);
            this._failedCount++;
            failed++;
            // Push this dependent's own dependents (iterative, no recursion).
            for (const grandId of dep.dependents)
                stack.push(grandId);
        }
        return failed;
    }
    /**
     * Cycle-detection helper: does `id` (whose existing deps are `deps`) reach
     * `target` through dependsOn edges?  `target` is an EXISTING node that
     * forward-references `id`, so `id` → … → `target` → `id` would be a cycle.
     *
     * `id` reaches `target` iff target ∈ deps (direct edge) OR some dep of id
     * transitively depends on target.  BFS over existing nodes with a visited
     * set.  O(V+E) worst case, but only invoked for forward-reference endpoints
     * (rare).
     */
    idReaches(id, deps, target) {
        // Direct edge: id depends on target, and target depends on id (forward).
        if (deps.includes(target))
            return true;
        // BFS from id's deps following dependsOn through existing nodes.
        const visited = new Set(deps);
        const queue = [...deps];
        while (queue.length > 0) {
            const d = queue.pop();
            const dInternal = this.tasks.get(d);
            if (!dInternal)
                continue; // forward ref or removed — not on a cycle path
            for (const dep of dInternal.dependsOn) {
                if (dep === target)
                    return true; // d depends on target → id→d→target→id
                if (!visited.has(dep)) {
                    visited.add(dep);
                    queue.push(dep);
                }
            }
        }
        return false;
    }
    /**
     * Reconstruct a dependency path from `deps` to `target` for error messages.
     * Only used when a cycle IS detected (exceptional path).
     */
    pathFrom(deps, target) {
        if (deps.includes(target))
            return [target];
        // Re-run BFS tracking parents to extract the path.
        const parent = new Map();
        const visited = new Set(deps);
        const queue = [...deps];
        while (queue.length > 0) {
            const d = queue.pop();
            if (d === target) {
                // Reconstruct path target → … → d → target
                const path = [d];
                let cur = d;
                while (parent.has(cur)) {
                    cur = parent.get(cur);
                    path.unshift(cur);
                }
                return path;
            }
            const dInternal = this.tasks.get(d);
            if (!dInternal)
                continue;
            for (const dep of dInternal.dependsOn) {
                if (!visited.has(dep)) {
                    visited.add(dep);
                    parent.set(dep, d);
                    queue.push(dep);
                }
            }
        }
        return [target];
    }
}
exports.TaskScheduler = TaskScheduler;
//# sourceMappingURL=taskScheduler.js.map