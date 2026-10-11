/**
 * TaskScheduler
 * -------------
 * A production-grade, in-memory, dependency-aware task scheduler.
 *
 * Supports:
 *   - 1,000,000+ concurrent tasks
 *   - numeric priorities (higher = more urgent)
 *   - execution timestamps (epoch ms; tasks deferred until their time)
 *   - dependency tracking (DAG, forward references allowed)
 *   - dynamic updates (priority / scheduledAt changes on live tasks)
 *   - cycle detection (rejected at insertion)
 *   - O(1) next-executable retrieval (amortised O(log n) on promotion)
 *   - cascade-fail on removal and on dependency failure
 *
 * See README.md for the full architecture, data-structure and complexity
 * write-up.
 */
import {
  Task,
  TaskState,
  TaskStatus,
  SchedulerOptions,
} from './types';
import { MinHeap as MinHeapInternal } from './minheap';

/** A heap entry.  `version` is the task's internal version at push-time;
 *  an entry is stale when it no longer matches the live task's version. */
interface HeapEntry {
  id: string;
  /** Higher priority first (run-heap orders by -priority conceptually). */
  priority: number;
  /** For deferred-heap ordering.  0 = "as early as possible". */
  scheduledAt: number;
  /** Version stamp for lazy-deletion staleness. */
  version: number;
}

/** Mutable bookkeeping wrapped around the immutable public `Task`. */
interface Internal {
  /** The original, immutable public task. */
  task: Task;
  id: string;
  priority: number;
  scheduledAt: number | undefined;
  /**
   * Ids of dependencies that are NOT yet COMPLETED (missing OR uncompleted).
   * Shrink-only: entries are removed as their dependency completes.  When the
   * list is empty the task is dep-ready.  Using the list length as the
   * readiness test makes it O(1) in JS (Array.length) and removes any
   * separate in-degree counter that could fall out of sync.
   */
  dependsOn: string[];
  /** Reverse edges: ids of tasks that depend on this one. */
  dependents: string[];
  /** Lifecycle state. */
  state: TaskState;
  /** Incremented on every change that affects heap ordering (update/remove).
   *  Used for lazy-deletion staleness. */
  version: number;
}

// ---- errors ------------------------------------------------------------

export class DuplicateTaskError extends Error {
  constructor(id: string) {
    super(`Task '${id}' already exists`);
    this.name = 'DuplicateTaskError';
  }
}
export class SelfDependencyError extends Error {
  constructor(id: string) {
    super(`Task '${id}' depends on itself`);
    this.name = 'SelfDependencyError';
  }
}
export class CycleError extends Error {
  constructor(path: string[]) {
    super(`Dependency cycle detected: ${path.join(' -> ')}`);
    this.name = 'CycleError';
    this.path = path;
  }
  /** The cycle path, from the offending node back to itself. */
  readonly path: string[];
}
export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Task '${id}' not found`);
    this.name = 'TaskNotFoundError';
  }
}
export class InvalidStateError extends Error {
  constructor(id: string, state: TaskState, required: TaskState) {
    super(`Task '${id}' is '${state}' but requires '${required}'`);
    this.name = 'InvalidStateError';
  }
}

// ---- scheduler ---------------------------------------------------------

export class TaskScheduler {
  /** Task lookup by id.  Only LIVE tasks (PENDING / RUNNING) are present. */
  private readonly tasks = new Map<string, Internal>();

  /** Forward references: referenced-id → set of added nodes that depend on it.
   *  Non-empty only for incrementally-built graphs.  Resolved (and cleared)
   *  when the referenced node is added. */
  private readonly forwardRefs = new Map<string, Set<string>>();

  /**
   * Run-heap: dep-ready AND time-eligible tasks, ordered by priority (desc)
   * then scheduledAt (asc) then id.  `peekNext` returns its top in O(1).
   * Lazy-deletion: stale entries (version mismatch) are discarded on pop.
   */
  private readonly runHeap: MinHeapInternal<HeapEntry>;

  /**
   * Deferred-heap: dep-ready but not yet time-eligible tasks, ordered by
   * scheduledAt (asc).  `promote` moves entries with scheduledAt <= now into
   * the run-heap.  This is the timer-wheel pattern: each task is promoted
   * exactly once, giving amortised O(log n) per promotion and O(1) peekNext
   * in between promotions.
   */
  private readonly deferredHeap: MinHeapInternal<HeapEntry>;

  /** Injectable clock (epoch ms).  Defaults to Date.now.  Override in tests. */
  private readonly clock: () => number;

  /** Metrics for observability. */
  private _completedCount = 0;
  private _failedCount = 0;
  private _addedCount = 0;

  constructor(options: SchedulerOptions = {}) {
    this.clock = options.now ?? Date.now;

    // run-heap: highest priority first; ties by earlier scheduledAt; ties by id.
    this.runHeap = new MinHeapInternal<HeapEntry>((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority; // desc
      if (a.scheduledAt !== b.scheduledAt) return a.scheduledAt - b.scheduledAt; // asc
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // stable
    });

    // deferred-heap: earliest scheduledAt first; ties by higher priority; ties by id.
    this.deferredHeap = new MinHeapInternal<HeapEntry>((a, b) => {
      if (a.scheduledAt !== b.scheduledAt) return a.scheduledAt - b.scheduledAt; // asc
      if (a.priority !== b.priority) return b.priority - a.priority; // desc
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // stable
    });
  }

  // ---- metrics ---------------------------------------------------------

  /** Number of live tasks (PENDING or RUNNING). */
  get size(): number {
    return this.tasks.size;
  }
  /** Total tasks added since construction (includes completed/failed/removed). */
  get addedCount(): number {
    return this._addedCount;
  }
  /** Tasks completed successfully. */
  get completedCount(): number {
    return this._completedCount;
  }
  /** Tasks failed (direct failure or cascade). */
  get failedCount(): number {
    return this._failedCount;
  }

  // ---- lifecycle -------------------------------------------------------

  /**
   * Add a task.
   *
   * @throws DuplicateTaskError   if `task.id` already exists.
   * @throws SelfDependencyError  if `task` depends on itself.
   * @throws CycleError           if adding `task` closes a dependency cycle.
   *
   * Complexity: O(|dependsOn|) typical; O(V+E) worst case, only when the task
   * is the endpoint of a forward-reference cycle (rare).  Forward references
   * are the ONLY way a cycle can form, so cycle detection is O(1) for the
   * overwhelmingly common case where dependencies are added before their
   * dependents.
   */
  add(task: Task): void {
    const id = task.id;
    if (this.tasks.has(id)) throw new DuplicateTaskError(id);

    const deps = task.dependsOn ?? [];
    if (deps.includes(id)) throw new SelfDependencyError(id);

    // ---- cycle detection (BEFORE any mutation, so no rollback needed) ----
    // A cycle can only be created by forward references: an existing node P
    // that depends on `id` (registered in forwardRefs[id]) combined with a
    // path from `id` back to P through `id`'s own (existing) dependencies.
    // If any such P exists and `id` reaches P, adding `id` closes a cycle:
    //   id → … → P → id   (P → id via forward ref)
    // The cycle path starts and ends at `id`.
    const forwardResolved = this.forwardRefs.get(id); // existing nodes depending on id
    if (forwardResolved) {
      for (const p of forwardResolved) {
        if (this.idReaches(id, deps, p)) {
          // pathFrom(deps, p) returns the path from some dep of `id` to `p`.
          // The full cycle is: id → (deps path) → p → id (forward ref).
          throw new CycleError([id, ...this.pathFrom(deps, p), id]);
        }
      }
    }

    // ---- apply the task --------------------------------------------------
    const internal: Internal = {
      task,
      id,
      priority: task.priority ?? 0,
      scheduledAt: task.scheduledAt,
      dependsOn: [...deps], // full list initially; shrinks as deps complete
      dependents: [],
      state: TaskState.PENDING,
      version: 0,
    };
    this.tasks.set(id, internal);
    this._addedCount++;

    // Resolve each dependency: if it is already COMPLETED it cannot be in the
    // unmet list (but completed tasks are removed from the map, so we check the
    // forwardRefs / live-map).  For each dependency that is NOT yet completed
    // (live and pending, or a forward reference) we register the reverse edge.
    for (const d of deps) {
      const depInternal = this.tasks.get(d);
      if (depInternal) {
        if (depInternal.state === TaskState.COMPLETED) {
          // Already satisfied — drop from unmet list.
          internal.dependsOn.splice(internal.dependsOn.indexOf(d), 1);
        } else {
          // `id` is unblocked when `d` completes.
          depInternal.dependents.push(id);
        }
      } else {
        // Forward reference: `d` does not exist yet.  Register that `id`
        // depends on `d`; resolved when `d` is added.
        let set = this.forwardRefs.get(d);
        if (!set) {
          set = new Set();
          this.forwardRefs.set(d, set);
        }
        set.add(id);
      }
    }

    // Resolve forward references pointing AT id: existing nodes added earlier
    // that depend on id.  Register them as dependents so complete(id) unblocks
    // them.  Their unmet lists already include id from their own add-time, so
    // we do NOT touch them here — only the reverse edge matters.
    if (forwardResolved) {
      for (const p of forwardResolved) {
        internal.dependents.push(p);
      }
      this.forwardRefs.delete(id);
    }

    // Schedule if all dependencies are satisfied (unmet list empty).
    if (internal.dependsOn.length === 0) {
      this.scheduleReady(internal);
    }
  }

  /**
   * Remove a task and cascade-fail all transitive dependents (they can never
   * complete without it).  The task and its dependents are deleted from the
   * scheduler; any heap entries they had become stale and are discarded on the
   * next retrieval.
   *
   * @returns true if the task existed and was removed.
   *
   * Complexity: O(subgraph size of dependents) — inherent, since every
   * dependent must be marked failed.
   */
  remove(id: string): boolean {
    const internal = this.tasks.get(id);
    if (!internal) return false;

    internal.state = TaskState.REMOVED;
    internal.version++; // invalidate any heap entry
    this.tasks.delete(id);

    // Cascade-fail transitive dependents.
    this.cascadeFail(id, internal.dependents);
    return true;
  }

  /**
   * Mark a RUNNING (claimed) task as completed (success) or failed.
   *
   * On success: decrement the in-degree of every dependent; any dependent
   * whose in-degree reaches 0 becomes ready and is scheduled (run-heap if
   * time-eligible, deferred-heap otherwise).
   *
   * On failure: cascade-fail all transitive dependents (they can never run).
   *
   * @returns the number of dependents affected (unblocked on success, failed
   *          on failure).
   *
   * @throws TaskNotFoundError   if `id` does not exist.
   * @throws InvalidStateError   if `id` is not RUNNING (call `claim` first).
   *
   * Complexity: O(out-degree) on success (amortised O(1) per edge over the
   * lifetime of the scheduler); O(dependent-subgraph) on failure.
   */
  complete(id: string, success: boolean = true, now?: number): number {
    const internal = this.tasks.get(id);
    if (!internal) throw new TaskNotFoundError(id);
    if (internal.state !== TaskState.RUNNING) {
      throw new InvalidStateError(id, internal.state, TaskState.RUNNING);
    }

    if (success) {
      internal.state = TaskState.COMPLETED;
      internal.version++;
      this.tasks.delete(id); // completed tasks leave the live map
      this._completedCount++;

      let unblocked = 0;
      const t = now ?? this.clock();
      for (const depId of internal.dependents) {
        const dep = this.tasks.get(depId);
        if (!dep || dep.state !== TaskState.PENDING) continue; // only unblock pending
        // Remove the completed dependency from dep's unmet list.
        const at = dep.dependsOn.indexOf(id);
        if (at !== -1) dep.dependsOn.splice(at, 1);
        unblocked++;
        if (dep.dependsOn.length === 0) {
          this.scheduleReady(dep, t); // ready: push to run- or deferred-heap
        }
      }
      return unblocked;
    } else {
      internal.state = TaskState.FAILED;
      internal.version++;
      this.tasks.delete(id);
      this._failedCount++;
      const failed = this.cascadeFail(id, internal.dependents);
      return failed;
    }
  }

  /**
   * Claim (pop) the next executable task and mark it RUNNING (in-flight).
   *
   * A task is executable when its dependencies are all COMPLETED AND its
   * scheduledAt (if any) has passed.  Among executable tasks, the highest
   * priority is returned first; ties broken by earlier scheduledAt then id.
   *
   * For an external-worker model: claim the task, execute it yourself, then
   * call `complete(id, ok)`.
   *
   * @returns the claimed task, or `undefined` when nothing is executable now.
   *
   * Complexity: O(1) plus amortised O(log n) for promotions and O(k · log n)
   * for discarding k stale entries.
   */
  claim(now?: number): Task | undefined {
    const t = now ?? this.clock();
    this.promote(t); // move time-eligible deferred tasks into the run-heap

    for (;;) {
      const entry = this.runHeap.pop();
      if (!entry) return undefined;
      const internal = this.tasks.get(entry.id);
      // Stale: task removed/failed/completed, or re-scheduled with a newer version.
      if (!internal || internal.state !== TaskState.PENDING || entry.version !== internal.version) {
        continue; // discard, try the next entry
      }
      internal.state = TaskState.RUNNING; // in-flight
      return internal.task;
    }
  }

  /**
   * Non-destructive preview: which task would `claim` return at time `now`?
   *
   * Stale entries at the top of the run-heap are discarded (they are garbage
   * and safe to drop).  The valid top entry is peeked, not popped, so a
   * subsequent `claim` returns the same task.
   *
   * @returns the next executable task, or `undefined`.
   *
   * Complexity: O(k · log n) for discarding k stale entries + O(1) peek.
   */
  peekNext(now?: number): Task | undefined {
    const t = now ?? this.clock();
    this.promote(t);

    for (;;) {
      const entry = this.runHeap.peek();
      if (!entry) return undefined;
      const internal = this.tasks.get(entry.id);
      if (internal && internal.state === TaskState.PENDING && entry.version === internal.version) {
        return internal.task; // valid — do NOT pop
      }
      this.runHeap.pop(); // stale — discard, check the next entry
    }
  }

  /**
   * Convenience for synchronous in-process execution: claim the next task and
   * immediately complete it successfully (unblocking its dependents).
   *
   * @returns the executed task, or `undefined` when nothing is executable.
   */
  execute(now?: number): Task | undefined {
    const task = this.claim(now);
    if (!task) return undefined;
    this.complete(task.id, true, now);
    return task;
  }

  /**
   * Dynamically update a task's priority and/or scheduledAt.
   *
   * If the task is dep-ready (in a heap), a fresh heap entry is pushed with
   * the new values; the old entry becomes stale (version mismatch) and is
   * discarded on the next retrieval.  If the task is not yet dep-ready or is
   * RUNNING, only the stored values change (they take effect when the task
   * becomes ready / on completion respectively).
   *
   * @throws TaskNotFoundError if `id` does not exist.
   *
   * Complexity: O(log n) when the task is dep-ready (heap re-insertion);
   * O(1) otherwise.
   */
  update(id: string, patch: { priority?: number; scheduledAt?: number }): void {
    const internal = this.tasks.get(id);
    if (!internal) throw new TaskNotFoundError(id);
    if (patch.priority !== undefined) internal.priority = patch.priority;
    if (patch.scheduledAt !== undefined) internal.scheduledAt = patch.scheduledAt;
    internal.version++; // invalidate any existing heap entry
    // Re-schedule if the task is dep-ready (in-degree 0, still pending).
    if (internal.state === TaskState.PENDING && internal.dependsOn.length === 0) {
      this.scheduleReady(internal);
    }
  }

  /**
   * Inspect a task's current status.
   *
   * @returns the status snapshot, or `undefined` if the task does not exist
   *          (or is no longer live — completed/failed/removed).
   */
  get(id: string): TaskStatus | undefined {
    const internal = this.tasks.get(id);
    if (!internal) return undefined;
    // `dependsOn` holds exactly the dependencies that are not yet completed
    // (shrink-only, entries removed on completion).  It is the unmet list.
    return {
      id,
      state: internal.state,
      priority: internal.priority,
      scheduledAt: internal.scheduledAt,
      unmetDependencies: internal.dependsOn,
      dependentsCount: internal.dependents.length,
      payload: internal.task.payload,
    };
  }

  /**
   * O(1) check for whether a task is live (PENDING or RUNNING).
   */
  has(id: string): boolean {
    return this.tasks.has(id);
  }

  // ---- internals -------------------------------------------------------

  /**
   * Schedule a dep-ready task.  Pushes to the run-heap if time-eligible now,
   * else to the deferred-heap (promoted when its scheduledAt arrives).
   */
  private scheduleReady(internal: Internal, now?: number): void {
    if (internal.state !== TaskState.PENDING) return; // already claimed/completed
    const t = now ?? this.clock();
    const entry: HeapEntry = {
      id: internal.id,
      priority: internal.priority,
      scheduledAt: internal.scheduledAt ?? 0,
      version: internal.version,
    };
    if (internal.scheduledAt === undefined || internal.scheduledAt <= t) {
      this.runHeap.push(entry); // eligible now
    } else {
      this.deferredHeap.push(entry); // deferred until scheduledAt
    }
  }

  /**
   * Move deferred entries with scheduledAt <= now into the run-heap.
   * Stale deferred entries (task removed/updated) are discarded, not moved.
   *
   * This is the timer-wheel promotion step.  Each task is promoted at most
   * once (amortised O(log n)); peekNext in between promotions is O(1).
   */
  private promote(now: number): void {
    for (;;) {
      const entry = this.deferredHeap.peek();
      if (!entry || entry.scheduledAt > now) break;
      this.deferredHeap.pop(); // remove from deferred-heap
      const internal = this.tasks.get(entry.id);
      if (!internal || internal.state !== TaskState.PENDING || entry.version !== internal.version) {
        continue; // stale — discard
      }
      this.runHeap.push(entry); // now time-eligible — move to run-heap
    }
  }

  /**
   * Cascade-fail all transitive dependents of a failed/removed task.
   * Uses an explicit stack (not recursion) to avoid stack overflow on deep
   * dependency chains (1M-deep is trivial for a stack, fatal for call frames).
   *
   * @returns the number of dependents failed.
   */
  private cascadeFail(fromId: string, directDependents: string[]): number {
    let failed = 0;
    const stack: string[] = [...directDependents];
    while (stack.length > 0) {
      const depId = stack.pop()!;
      const dep = this.tasks.get(depId);
      if (!dep || dep.state !== TaskState.PENDING) continue;
      dep.state = TaskState.FAILED;
      dep.version++;
      this.tasks.delete(depId);
      this._failedCount++;
      failed++;
      // Push this dependent's own dependents (iterative, no recursion).
      for (const grandId of dep.dependents) stack.push(grandId);
    }
    return failed;
  }

  /**
   * Cycle-detection helper: does `id` (whose existing deps are `deps`) reach
   * `target` through dependsOn edges?  `target` is an EXISTING node that
   * forward-references `id`, so `id` → … → `target` → `id` would be a cycle.
   *
   * `id` reaches `target` iff target ∈ deps (direct edge) OR some dep of id
   * transitively depends on target.  BFS over existing nodes with a visited
   * set.  O(V+E) worst case, but only invoked for forward-reference endpoints
   * (rare).
   */
  private idReaches(id: string, deps: string[], target: string): boolean {
    // Direct edge: id depends on target, and target depends on id (forward).
    if (deps.includes(target)) return true;
    // BFS from id's deps following dependsOn through existing nodes.
    const visited = new Set<string>(deps);
    const queue: string[] = [...deps];
    while (queue.length > 0) {
      const d = queue.pop()!;
      const dInternal = this.tasks.get(d);
      if (!dInternal) continue; // forward ref or removed — not on a cycle path
      for (const dep of dInternal.dependsOn) {
        if (dep === target) return true; // d depends on target → id→d→target→id
        if (!visited.has(dep)) {
          visited.add(dep);
          queue.push(dep);
        }
      }
    }
    return false;
  }

  /**
   * Reconstruct a dependency path from `deps` to `target` for error messages.
   * Only used when a cycle IS detected (exceptional path).
   */
  private pathFrom(deps: string[], target: string): string[] {
    if (deps.includes(target)) return [target];
    // Re-run BFS tracking parents to extract the path.
    const parent = new Map<string, string>();
    const visited = new Set<string>(deps);
    const queue: string[] = [...deps];
    while (queue.length > 0) {
      const d = queue.pop()!;
      if (d === target) {
        // Reconstruct path target → … → d → target
        const path: string[] = [d];
        let cur = d;
        while (parent.has(cur)) {
          cur = parent.get(cur)!;
          path.unshift(cur);
        }
        return path;
      }
      const dInternal = this.tasks.get(d);
      if (!dInternal) continue;
      for (const dep of dInternal.dependsOn) {
        if (!visited.has(dep)) {
          visited.add(dep);
          parent.set(dep, d);
          queue.push(dep);
        }
      }
    }
    return [target];
  }
}

