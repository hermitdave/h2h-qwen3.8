"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecutorError = exports.DoubleDispatchError = exports.InvalidUpdateError = exports.CircularDependencyError = exports.SelfDependencyError = exports.InvalidDependencyError = exports.UnknownTaskError = exports.DuplicateTaskError = exports.SchedulerError = void 0;
/**
 * Domain errors thrown by the scheduler. Each carries a machine-readable
 * `code` so callers (and tests) can branch on the *kind* of error without
 * pattern-matching on message strings.
 */
class SchedulerError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'SchedulerError';
        this.code = code;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
exports.SchedulerError = SchedulerError;
class DuplicateTaskError extends SchedulerError {
    constructor(id) {
        super('DUPLICATE_TASK', `A task with id "${id}" already exists.`);
        this.name = 'DuplicateTaskError';
    }
}
exports.DuplicateTaskError = DuplicateTaskError;
class UnknownTaskError extends SchedulerError {
    constructor(id) {
        super('UNKNOWN_TASK', `No task with id "${id}".`);
        this.name = 'UnknownTaskError';
    }
}
exports.UnknownTaskError = UnknownTaskError;
class InvalidDependencyError extends SchedulerError {
    constructor(id, dependency) {
        super('INVALID_DEPENDENCY', `Task "${id}" cannot depend on unknown task "${dependency}".`);
        this.name = 'InvalidDependencyError';
    }
}
exports.InvalidDependencyError = InvalidDependencyError;
class SelfDependencyError extends SchedulerError {
    constructor(id) {
        super('SELF_DEPENDENCY', `Task "${id}" cannot depend on itself.`);
        this.name = 'SelfDependencyError';
    }
}
exports.SelfDependencyError = SelfDependencyError;
class CircularDependencyError extends SchedulerError {
    /** Ordered vertex ids along the cycle (the first one may be repeated at the end). */
    cycle;
    constructor(cycle) {
        super('CIRCULAR_DEPENDENCY', `Adding this edge creates a dependency cycle: ${cycle.join(' -> ')}.`);
        this.name = 'CircularDependencyError';
        this.cycle = cycle;
    }
}
exports.CircularDependencyError = CircularDependencyError;
class InvalidUpdateError extends SchedulerError {
    constructor(message) {
        super('INVALID_UPDATE', message);
        this.name = 'InvalidUpdateError';
    }
}
exports.InvalidUpdateError = InvalidUpdateError;
class DoubleDispatchError extends SchedulerError {
    constructor(id) {
        super('DOUBLE_DISPATCH', `Task "${id}" is already in flight and cannot be dispatched again.`);
        this.name = 'DoubleDispatchError';
    }
}
exports.DoubleDispatchError = DoubleDispatchError;
class ExecutorError extends SchedulerError {
    constructor(id, cause) {
        super('EXECUTOR_ERROR', `Executor threw for task "${id}": ${cause instanceof Error ? cause.message : String(cause)}`);
        this.name = 'ExecutorError';
        this.cause = cause;
    }
}
exports.ExecutorError = ExecutorError;
