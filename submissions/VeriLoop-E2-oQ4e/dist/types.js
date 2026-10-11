"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskState = void 0;
/** Lifecycle states a task can be in. */
var TaskState;
(function (TaskState) {
    /** Created, not yet ready to run (deps not satisfied or scheduled later). */
    TaskState["PENDING"] = "pending";
    /** All deps satisfied & time reached — ready to be executed by a worker. */
    TaskState["READY"] = "ready";
    /** Claimed by a worker and in-flight. */
    TaskState["RUNNING"] = "running";
    /** Execution finished successfully. */
    TaskState["COMPLETED"] = "completed";
    /** A dependency failed; this task can never run. */
    TaskState["FAILED"] = "failed";
    /** Removed from the scheduler. */
    TaskState["REMOVED"] = "removed";
})(TaskState || (exports.TaskState = TaskState = {}));
//# sourceMappingURL=types.js.map