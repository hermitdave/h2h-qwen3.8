/**
 * Task lifecycle states.
 *
 * A task moves through exactly one of these states at any time:
 *
 *   pending  -> awaiting (terminal/non-terminal) -> done
 *   pending  -> cancelled
 *   pending  -> failed
 *
 * `pending`    : freshly created, has at least one unsatisfied dependency.
 * `awaiting`   : every dependency is satisfied (completed or cancelled); the task is
 *                "ready" to run, subject to its priority and execution timestamp.
 * `done`       : execution finished successfully.
 * `cancelled`  : explicitly cancelled by the caller.
 * `failed`     : execution finished with an error.
 */
export type TaskStatus = 'pending' | 'awaiting' | 'done' | 'cancelled' | 'failed';
/**
 * Input required to create a task. `name` and `payload` are optional
 * (the scheduler auto-generates a unique id if `id` is omitted).
 */
export interface TaskInput {
    /** Stable unique identifier. Omit to auto-generate one. */
    id?: string;
    /** Optional human-readable name (for logging/debugging). */
    name?: string;
    /** Priority. Higher value runs first. Defaults to 0. */
    priority?: number;
    /** Unix epoch milliseconds at which the task is eligible to run. Defaults to now. */
    executeAt?: number;
    /** Identifiers of tasks that must complete (or be cancelled) before this one. */
    dependencies?: string[];
    /** Optional opaque payload handed to the executor. */
    payload?: unknown;
}
/** A fully-resolved task record as held by the scheduler. */
export interface Task {
    /** Stable unique identifier. */
    id: string;
    /** Human-readable name, or the id if none was supplied. */
    name: string;
    /** Current lifecycle state. */
    status: TaskStatus;
    /** Priority at time of creation. Higher runs first. */
    priority: number;
    /** Unix epoch ms eligibility timestamp at time of creation. */
    executeAt: number;
    /** Dependency identifiers. */
    dependencies: string[];
    /** Dependencies satisfied (done or cancelled). Derived / maintained by the scheduler. */
    satisfiedDependencies: number;
    /**
     * Number of still-unsatisfied dependencies. 0 == all deps done or cancelled
     * (task is runnable). Tracked on the record itself so a 1M-task graph carries
     * no separate bookkeeping Map — this keeps the per-task constant and the
     * number of large Maps bounded.
     */
    unsatisfied: number;
    /** Optional opaque payload. */
    payload?: unknown;
    /** Wall-clock time the task was created. */
    createdAt: number;
    /** Wall-clock time the task first became awaiting, or null. */
    awaitingSince: number | null;
    /** Wall-clock time execution started, or null. */
    startedAt: number | null;
    /** Wall-clock time execution finished, or null. */
    finishedAt: number | null;
    /** Error reason if status === 'failed'. */
    error?: string;
}
/** What a successful run produces. The scheduler stores nothing by default. */
export type TaskResult = unknown;
/**
 * A pluggable execution function. The scheduler treats execution as opaque:
 * it calls this for each task the moment the task becomes eligible and records
 * the result/latency. It never inspects `payload` and never blocks.
 */
export type TaskExecutor = (task: Task, payload: unknown) => TaskResult | Promise<TaskResult>;
/**
 * The status the task is forced into if the executor throws. Defaults to 'failed'.
 * A subclass may implement custom retry / dead-letter semantics.
 */
export type OnErrorAction = 'failed' | (string & {});
