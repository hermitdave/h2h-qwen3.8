/**
 * Domain errors thrown by the scheduler. Each carries a machine-readable
 * `code` so callers (and tests) can branch on the *kind* of error without
 * pattern-matching on message strings.
 */
export declare class SchedulerError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare class DuplicateTaskError extends SchedulerError {
    constructor(id: string);
}
export declare class UnknownTaskError extends SchedulerError {
    constructor(id: string);
}
export declare class InvalidDependencyError extends SchedulerError {
    constructor(id: string, dependency: string);
}
export declare class SelfDependencyError extends SchedulerError {
    constructor(id: string);
}
export declare class CircularDependencyError extends SchedulerError {
    /** Ordered vertex ids along the cycle (the first one may be repeated at the end). */
    readonly cycle: string[];
    constructor(cycle: string[]);
}
export declare class InvalidUpdateError extends SchedulerError {
    constructor(message: string);
}
export declare class DoubleDispatchError extends SchedulerError {
    constructor(id: string);
}
export declare class ExecutorError extends SchedulerError {
    constructor(id: string, cause: unknown);
}
