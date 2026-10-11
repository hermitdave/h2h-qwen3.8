/**
 * Domain errors thrown by the scheduler. Each carries a machine-readable
 * `code` so callers (and tests) can branch on the *kind* of error without
 * pattern-matching on message strings.
 */
export class SchedulerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SchedulerError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DuplicateTaskError extends SchedulerError {
  constructor(id: string) {
    super(
      'DUPLICATE_TASK',
      `A task with id "${id}" already exists.`,
    );
    this.name = 'DuplicateTaskError';
  }
}

export class UnknownTaskError extends SchedulerError {
  constructor(id: string) {
    super('UNKNOWN_TASK', `No task with id "${id}".`);
    this.name = 'UnknownTaskError';
  }
}

export class InvalidDependencyError extends SchedulerError {
  constructor(id: string, dependency: string) {
    super(
      'INVALID_DEPENDENCY',
      `Task "${id}" cannot depend on unknown task "${dependency}".`,
    );
    this.name = 'InvalidDependencyError';
  }
}

export class SelfDependencyError extends SchedulerError {
  constructor(id: string) {
    super('SELF_DEPENDENCY', `Task "${id}" cannot depend on itself.`);
    this.name = 'SelfDependencyError';
  }
}

export class CircularDependencyError extends SchedulerError {
  /** Ordered vertex ids along the cycle (the first one may be repeated at the end). */
  readonly cycle: string[];
  constructor(cycle: string[]) {
    super(
      'CIRCULAR_DEPENDENCY',
      `Adding this edge creates a dependency cycle: ${cycle.join(' -> ')}.`,
    );
    this.name = 'CircularDependencyError';
    this.cycle = cycle;
  }
}

export class InvalidUpdateError extends SchedulerError {
  constructor(message: string) {
    super('INVALID_UPDATE', message);
    this.name = 'InvalidUpdateError';
  }
}

export class DoubleDispatchError extends SchedulerError {
  constructor(id: string) {
    super('DOUBLE_DISPATCH', `Task "${id}" is already in flight and cannot be dispatched again.`);
    this.name = 'DoubleDispatchError';
  }
}

export class ExecutorError extends SchedulerError {
  constructor(id: string, cause: unknown) {
    super(
      'EXECUTOR_ERROR',
      `Executor threw for task "${id}": ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'ExecutorError';
    this.cause = cause;
  }
}
