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
import { Task, TaskState, TaskStatus, SchedulerOptions } from './types';
export declare class DuplicateTaskError extends Error {
    constructor(id: string);
}
export declare class SelfDependencyError extends Error {
    constructor(id: string);
}
export declare class CycleError extends Error {
    constructor(path: string[]);
    /** The cycle path, from the offending node back to itself. */
    readonly path: string[];
}
export declare class TaskNotFoundError extends Error {
    constructor(id: string);
}
export declare class InvalidStateError extends Error {
    constructor(id: string, state: TaskState, required: TaskState);
}
export declare class TaskScheduler {
    /** Task lookup by id.  Only LIVE tasks (PENDING / RUNNING) are present. */
    private readonly tasks;
    /** Forward references: referenced-id → set of added nodes that depend on it.
     *  Non-empty only for incrementally-built graphs.  Resolved (and cleared)
     *  when the referenced node is added. */
    private readonly forwardRefs;
    /**
     * Run-heap: dep-ready AND time-eligible tasks, ordered by priority (desc)
     * then scheduledAt (asc) then id.  `peekNext` returns its top in O(1).
     * Lazy-deletion: stale entries (version mismatch) are discarded on pop.
     */
    private readonly runHeap;
    /**
     * Deferred-heap: dep-ready but not yet time-eligible tasks, ordered by
     * scheduledAt (asc).  `promote` moves entries with scheduledAt <= now into
     * the run-heap.  This is the timer-wheel pattern: each task is promoted
     * exactly once, giving amortised O(log n) per promotion and O(1) peekNext
     * in between promotions.
     */
    private readonly deferredHeap;
    /** Injectable clock (epoch ms).  Defaults to Date.now.  Override in tests. */
    private readonly clock;
    /** Metrics for observability. */
    private _completedCount;
    private _failedCount;
    private _addedCount;
    constructor(options?: SchedulerOptions);
    /** Number of live tasks (PENDING or RUNNING). */
    get size(): number;
    /** Total tasks added since construction (includes completed/failed/removed). */
    get addedCount(): number;
    /** Tasks completed successfully. */
    get completedCount(): number;
    /** Tasks failed (direct failure or cascade). */
    get failedCount(): number;
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
    add(task: Task): void;
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
    remove(id: string): boolean;
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
    complete(id: string, success?: boolean, now?: number): number;
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
    claim(now?: number): Task | undefined;
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
    peekNext(now?: number): Task | undefined;
    /**
     * Convenience for synchronous in-process execution: claim the next task and
     * immediately complete it successfully (unblocking its dependents).
     *
     * @returns the executed task, or `undefined` when nothing is executable.
     */
    execute(now?: number): Task | undefined;
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
    update(id: string, patch: {
        priority?: number;
        scheduledAt?: number;
    }): void;
    /**
     * Inspect a task's current status.
     *
     * @returns the status snapshot, or `undefined` if the task does not exist
     *          (or is no longer live — completed/failed/removed).
     */
    get(id: string): TaskStatus | undefined;
    /**
     * O(1) check for whether a task is live (PENDING or RUNNING).
     */
    has(id: string): boolean;
    /**
     * Schedule a dep-ready task.  Pushes to the run-heap if time-eligible now,
     * else to the deferred-heap (promoted when its scheduledAt arrives).
     */
    private scheduleReady;
    /**
     * Move deferred entries with scheduledAt <= now into the run-heap.
     * Stale deferred entries (task removed/updated) are discarded, not moved.
     *
     * This is the timer-wheel promotion step.  Each task is promoted at most
     * once (amortised O(log n)); peekNext in between promotions is O(1).
     */
    private promote;
    /**
     * Cascade-fail all transitive dependents of a failed/removed task.
     * Uses an explicit stack (not recursion) to avoid stack overflow on deep
     * dependency chains (1M-deep is trivial for a stack, fatal for call frames).
     *
     * @returns the number of dependents failed.
     */
    private cascadeFail;
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
    private idReaches;
    /**
     * Reconstruct a dependency path from `deps` to `target` for error messages.
     * Only used when a cycle IS detected (exceptional path).
     */
    private pathFrom;
}
//# sourceMappingURL=taskScheduler.d.ts.map