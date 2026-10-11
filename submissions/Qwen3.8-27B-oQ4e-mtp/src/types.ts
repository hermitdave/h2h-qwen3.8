/**
 * Core public types for the task scheduler.
 *
 * A task is a node in a directed acyclic dependency graph. It has:
 *  - an immutable id
 *  - a mutable priority (higher = more urgent)
 *  - a mutable scheduled-at timestamp (earliest time it may run)
 *  - a mutable state (state machine, see TaskState)
 *  - a stable creation sequence number (tiebreaker)
 *
 * `TaskRecord` is the runtime representation stored in the scheduler.
 * It is mutable by design: priorities, timestamps and dependency edges
 * can all change dynamically at runtime (see `TaskScheduler.update*`).
 */

/**
 * Lifecycle states a task can be in. Transitions are enforced by the
 * scheduler (see TaskScheduler.transitionTask for the allowed transitions).
 *
 *  - QUEUED      — created, waiting for dependencies / scheduled time
 *  - READY       — all deps satisfied and due (only implicit, produced
 *                  by nextExecutableTask())
 *  - RUNNING     - started by the consumer via markRunning()
 *  - SUCCEEDED   — finished successfully (terminal)
 *  - FAILED      — finished with an error (terminal, but can be
 *                  re-queued via retry)
 *  - CANCELLED   — removed from the plan (terminal)
 */
export type TaskState =
  | "QUEUED"
  | "READY"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

/** Terminal states that never leave the scheduler (until removed). */
export const TERMINAL_STATES: readonly TaskState[] = [
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;

export interface TaskRecord {
  id: string;
  /** Priority: higher number = more urgent. Default 0. */
  priority: number;
  /** Epoch milliseconds. Task is not eligible before this instant. */
  scheduledAt: number;
  state: TaskState;
  /** Monotonic creation counter — the ultimate tiebreaker. */
  seq: number;
  /** In-degree of *live* (QUEUED) predecessors in the dependency DAG. */
  unmet: number;
  /** Full outgoing edge set. Edges to succeeded/cancelled predecessors
   *  are removed eagerly, so this is the *effective* live edge set. */
  successors: Set<string>;
  /** Reverse edges: live predecessors that must finish first. */
  predecessors: Set<string>;
  /** Structured payload for the consumer. Opaque to the scheduler. */
  payload: unknown;
  /** Human-readable label. */
  label: string;
}

/**
 * A validated, sorted comparator entry. The heap compares two entries by:
 *   1. scheduledAt  (earlier first)
 *   2. priority     (higher first)
 *   3. seq          (earlier-created first)
 *
 * This key ordering is what makes "next executable task" a single
 * heap peek — see the README for the full proof.
 */
export interface HeapEntry {
  id: string;
  scheduledAt: number;
  priority: number;
  seq: number;
}

/** Input for adding a task. All fields optional except id. */
export interface AddTaskInput {
  id: string;
  priority?: number;
  scheduledAt?: number;
  payload?: unknown;
  label?: string;
  /** Dependency ids that must be satisfied before this task is eligible. */
  dependsOn?: readonly string[];
}

/** Input for a partial dynamic update of an existing task. */
export interface UpdateTaskInput {
  priority?: number;
  scheduledAt?: number;
  label?: string;
  payload?: unknown;
}

/**
 * A "next executable" handle. The scheduler hands these to the consumer,
 * which then calls `markRunning()` / `succeedTask()` / `failTask()`.
 */
export interface NextExecutable {
  id: string;
  priority: number;
  scheduledAt: number;
  seq: number;
  state: TaskState;
}

/** Result of a `validateGraph` / cycle check. */
export interface CycleReport {
  /** null when the graph is acyclic. Otherwise one concrete back-edge
   *  path forming the cycle, in traversal order. */
  cycle: string[] | null;
  /** Node count / edge count for the checker's own reporting. */
  nodes: number;
  edges: number;
}

/** Scheduler statistics snapshot. */
export interface SchedulerStats {
  total: number;
  byState: Record<TaskState, number>;
  pending: number; // QUEUED (not yet eligible to run)
  edges: number;
  heapSize: number;
}
