/**
 * Shared types for the task scheduler.
 *
 * Design notes
 * ------------
 * - `Task` is intentionally minimal and immutable-in-spirit: the scheduler
 *   stores a `TaskInternal` wrapper that adds mutable bookkeeping (in-degree,
 *   completion state).  Public callers only ever see `Task`.
 * - Dependencies are expressed as **edge ids** (`dependsOn: string[]`), i.e.
 *   "task X depends on tasks Y, Z".  The scheduler inverts these into
 *   `dependents: Map<id, id[]>` for O(1) fan-out when a task completes.
 * - `priority` is a number where **higher = more urgent**.  This matches the
 *   intuition of "priority 10 is more important than priority 1".  The heap
 *   uses negative priority internally so a standard min-heap surfaces the
 *   highest-priority task first.
 * - `scheduledAt` is an optional epoch-millis timestamp.  A task whose
 *   `scheduledAt > now` is not yet eligible; it stays in the heap but is
 *   skipped by `peekNext` until its timestamp has passed.  Callers can pass
 *   `now` explicitly for deterministic behaviour.
 */

/** A task as provided by the caller.  The scheduler never mutates this object. */
export interface Task {
  /** Stable unique identifier. */
  id: string;
  /** Urgency: higher number = more important.  Default 0. */
  priority?: number;
  /**
   * Optional execution timestamp (epoch ms).  A task with `scheduledAt > now`
   * is deferred until its time arrives.  Omit for "run as soon as deps met".
   */
  scheduledAt?: number;
  /**
   * Ids of tasks that must complete before this one can run.
   * Cycles are rejected at insertion time.
   */
  dependsOn?: string[];
  /** Arbitrary opaque payload.  The scheduler treats it as an unknown. */
  payload?: unknown;
}

/** Lifecycle states a task can be in. */
export enum TaskState {
  /** Created, not yet ready to run (deps not satisfied or scheduled later). */
  PENDING = 'pending',
  /** All deps satisfied & time reached — ready to be executed by a worker. */
  READY = 'ready',
  /** Claimed by a worker and in-flight. */
  RUNNING = 'running',
  /** Execution finished successfully. */
  COMPLETED = 'completed',
  /** A dependency failed; this task can never run. */
  FAILED = 'failed',
  /** Removed from the scheduler. */
  REMOVED = 'removed'
}

/** Snapshot of a task's current state as returned by `get()`. */
export interface TaskStatus {
  id: string;
  state: TaskState;
  priority: number;
  scheduledAt: number | undefined;
  /** Ids of uncompleted dependencies (empty when READY or COMPLETED). */
  unmetDependencies: string[];
  /** Ids of tasks that depend on this one (for diagnostics). */
  dependentsCount: number;
  /** Payload passthrough (opaque). */
  payload?: unknown;
}

/**
 * Comparison function signature for the generic heap.  `a` and `b` are heap
 * items; return < 0 if `a` should come out first.
 */
export type Comparator<T> = (a: T, b: T) => number;

/** Options accepted by `TaskScheduler` construction. */
export interface SchedulerOptions {
  /**
   * A function that returns the current time in epoch ms.  Defaults to
   * `Date.now`.  Override in tests for determinism.
   */
  now?: () => number;
  /**
   * Whether the scheduler should eagerly validate that every `dependsOn`
   * id refers to an already-existing task.  Defaults to `true`.
   *
   * Set to `false` for **forward references**: you may add task B with
   * `dependsOn: ['A']` before adding task A.  The scheduler will keep B
   * PENDING until A is added and completed.  Forward references are the
   * primary way to build large graphs incrementally.
   */
  allowForwardReferences?: boolean;
}
