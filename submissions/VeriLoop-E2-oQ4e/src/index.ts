/**
 * VeriLoop-E2-oQ4e — Production in-memory task scheduler.
 *
 * Public API:
 *   - TaskScheduler   — the scheduler
 *   - MinHeap<T>      — the underlying generic priority queue (exposed for
 *                       reuse in other systems)
 *   - Task, TaskState, TaskStatus, SchedulerOptions, Comparator — types
 *   - Error types — DuplicateTaskError, SelfDependencyError, CycleError,
 *                   TaskNotFoundError, InvalidStateError
 *
 * See README.md for architecture, data structures, complexity analysis and a
 * scalability discussion.
 */
export { TaskScheduler } from './taskScheduler';
export {
  DuplicateTaskError,
  SelfDependencyError,
  CycleError,
  TaskNotFoundError,
  InvalidStateError,
} from './taskScheduler';
export { MinHeap, createMinHeap } from './minheap';
export {
  Task,
  TaskState,
  TaskStatus,
  SchedulerOptions,
  Comparator,
} from './types';
