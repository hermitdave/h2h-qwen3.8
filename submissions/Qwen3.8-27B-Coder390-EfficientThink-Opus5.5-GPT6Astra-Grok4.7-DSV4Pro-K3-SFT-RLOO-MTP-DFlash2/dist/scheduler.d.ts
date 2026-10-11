import { Clock } from './clock';
import { ExecutorError } from './errors';
import { Task, TaskExecutor, TaskInput, TaskStatus } from './types';
/**
 * Sort key for the ready set. Ordering is a total order:
 *   1. earlier `executeAt` first (timestamp dominance),
 *   2. then higher `priority` first,
 *   3. then earlier `createdAt` first (stable FIFO among full ties),
 *   4. then lexicographic `id` (final deterministic tie-break).
 * The comparator returns <0 when `a` should run before `b`.
 */
export declare function readySetCompare(a: Task, b: Task): number;
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
export declare class TaskScheduler {
    private readonly tasks;
    /** id -> ids this task directly depends on. */
    private readonly deps;
    /** id -> ids that directly depend on this task (reverse edges). */
    private readonly dependents;
    /** The ready set: all awaiting tasks (due or not). */
    private readonly ready;
    /** Popped but not yet completed — guards against double-service. */
    private readonly dispatched;
    private readonly clock;
    private idCounter;
    constructor(clock?: Clock);
    /** Number of tasks in every state. */
    get size(): number;
    /** Number of tasks currently in the ready set (all awaiting tasks). */
    get readyCount(): number;
    statusCounts(): Record<TaskStatus, number>;
    has(id: string): boolean;
    get(id: string): Task | undefined;
    /**
     * Add a task. Validates dependencies, rejects self/circular/unknown deps,
     * and immediately inserts into the ready set if the task has no
     * (or all already-satisfied) dependencies. Returns the created task.
     *
     * @throws DuplicateTaskError, SelfDependencyError, InvalidDependencyError.
     */
    addTask(input: TaskInput): Task;
    /**
     * Return (and pop) the next executable task, or null if none. A task is
     * executable when it is awaiting AND `executeAt <= clock.now()`. Because the
     * ready heap orders by executeAt first, the min entry is the earliest-due
     * awaiting task: if it is not yet due, nothing is. O(log n).
     */
    next(): Task | null;
    /**
     * Mark a task completed successfully and propagate readiness to its
     * dependents. Idempotent on terminal states. O(1 + out-degree).
     */
    complete(id: string): void;
    /** Mark a task as failed. Dependents are NOT satisfied (they stay pending). */
    fail(id: string, error: unknown): void;
    /**
     * Cancel a task. Cancelling a pending/awaiting task satisfies its dependents
     * (design decision: a cancelled precondition is not a failed one). Cancelling
     * an in-flight (dispatched) task is rejected.
     */
    cancel(id: string): void;
    /** Update a task's priority; re-keys the ready entry. O(log n). */
    updatePriority(id: string, priority: number): void;
    /** Update a task's executeAt; re-keys the ready entry. O(log n). */
    updateExecuteAt(id: string, executeAt: number): void;
    /**
     * Add a dependency edge "id depends on dep". Runs an incremental cycle check.
     * If `dep` is already satisfied the task's unsatisfied count is unchanged;
     * otherwise it increments and, if the task was awaiting, it is re-pulled as
     * pending. O(V + E) worst case for the reachability check.
     */
    addDependency(id: string, dep: string): void;
    /**
     * Remove a dependency edge. Removing an already-satisfied dependency is a
     * no-op on readiness; removing an unsatisfied one may unblock the task.
     */
    removeDependency(id: string, dep: string): void;
    /**
     * Run every reachable task to completion using `executor`, then return the
     * count executed. Resolves tasks in ready-set order, awaiting each executor
     * result. Failures are recorded but do not stop the drain.
     */
    drain(executor: TaskExecutor): Promise<number>;
    /** Run up to `count` tasks (or until none ready), executing each. */
    run(executor: TaskExecutor, count: number): Promise<number>;
    /** Reset the scheduler (drops all state). For tests/reuse only. */
    clear(): void;
    /**
     * Flip pending -> awaiting when the last unsatisfied dep clears, and keep
     * the task in the ready set while awaiting. Idempotent: re-inserting an
     * already-present awaiting task is harmless (the heap dedupes by key).
     * Never inserts a task that is already dispatched (in flight).
     */
    private maybeReady;
    /** Re-key (remove+reinsert) the ready entry for id if it is awaiting. */
    private rekey;
    /** Drop id from the ready set if present. O(log n), no-op if absent. */
    private removeFromReady;
    /** Mark one dependency of t as satisfied (decrement unsatisfied). */
    private satisfy;
    /** After a task reaches a satisfied state, wake any dependents. */
    private onSatisfied;
    /** BFS in "depends on" direction from `from`, reporting reachability to `to`. */
    private isReachable;
    /** Reconstruct one cycle path for a clear error message.
     *
     * Called with (from=dep, to=id) when `addDependency(id, dep)` would close
     * a cycle. Returns a vertex list [id, dep, …, id] (start == end) such that
     * consecutive pairs describe "X depends on Y".
     */
    private extractCycle;
    private require;
    /** De-dupe dependency ids, preserving order. */
    private normalizeDeps;
    private generateId;
}
export { ExecutorError };
export type { TaskInput, Task, TaskStatus, TaskExecutor };
