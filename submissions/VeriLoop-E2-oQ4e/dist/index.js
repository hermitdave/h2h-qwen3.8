"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskState = exports.createMinHeap = exports.MinHeap = exports.InvalidStateError = exports.TaskNotFoundError = exports.CycleError = exports.SelfDependencyError = exports.DuplicateTaskError = exports.TaskScheduler = void 0;
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
var taskScheduler_1 = require("./taskScheduler");
Object.defineProperty(exports, "TaskScheduler", { enumerable: true, get: function () { return taskScheduler_1.TaskScheduler; } });
var taskScheduler_2 = require("./taskScheduler");
Object.defineProperty(exports, "DuplicateTaskError", { enumerable: true, get: function () { return taskScheduler_2.DuplicateTaskError; } });
Object.defineProperty(exports, "SelfDependencyError", { enumerable: true, get: function () { return taskScheduler_2.SelfDependencyError; } });
Object.defineProperty(exports, "CycleError", { enumerable: true, get: function () { return taskScheduler_2.CycleError; } });
Object.defineProperty(exports, "TaskNotFoundError", { enumerable: true, get: function () { return taskScheduler_2.TaskNotFoundError; } });
Object.defineProperty(exports, "InvalidStateError", { enumerable: true, get: function () { return taskScheduler_2.InvalidStateError; } });
var minheap_1 = require("./minheap");
Object.defineProperty(exports, "MinHeap", { enumerable: true, get: function () { return minheap_1.MinHeap; } });
Object.defineProperty(exports, "createMinHeap", { enumerable: true, get: function () { return minheap_1.createMinHeap; } });
var types_1 = require("./types");
Object.defineProperty(exports, "TaskState", { enumerable: true, get: function () { return types_1.TaskState; } });
//# sourceMappingURL=index.js.map