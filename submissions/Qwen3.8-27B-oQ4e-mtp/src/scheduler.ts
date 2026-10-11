import { MinHeap } from "./heap.js";
import { newGraph, addEdge, removeEdge, detectCycle, type Graph } from "./graph.js";
import type {
  AddTaskInput,
  CycleReport,
  HeapEntry,
  NextExecutable,
  SchedulerStats,
  TaskRecord,
  TaskState,
  TERMINAL_STATES,
  UpdateTaskInput,
} from "./types.js";
import { TERMINAL_STATES as TERMINAL } from "./types.js";

/**
 * Errors thrown by the scheduler. Each carries a stable `code` so callers
 * can switch on it without string matching.
 */
export class SchedulerError extends Error {
  constructor(
    public readonly code:
      | "TASK_NOT_FOUND"
      | "DUPLICATE_TASK"
      | "CYCLE_DETECTED"
      | "SELF_DEPENDENCY"
      | "UNKNOWN_DEPENDENCY"
      | "INVALID_TRANSITION"
      | "NOT_UPDATABLE"
      | "HEAP_INCONSISTENT",
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "SchedulerError";
  }
}

/**
 * In-memory task scheduler.
 *
 * Data structures (all O(1) per node, O(n) total):
 *   - `records: Map<string, TaskRecord>`  authoritative mutable state
 *   - `heap: MinHeap`                     ordered by (scheduledAt, priority, seq)
 *   - `graph: Graph`                      adjacency (adj + radj) over live edges
 *   - `seqCounter`                        monotonic creation counter
 *
 * Invariants maintained by every mutation:
 *   (I1) For every QUEUED record, `unmet` == number of live predecessors
 *        that are not yet SUCCEEDED. A task is executable iff
 *        unmet === 0 && now >= scheduledAt.
 *   (I2) Every QUEUED record has exactly one heap entry (may be stale
 *        after updates; the scheduler lazily re-pairs on peek).
 *   (I3) The dependency graph restricted to QUEUED/READY/RUNNING nodes is
 *        acyclic (enforced at add/update time).
 *
 * See README.md for the full architecture and complexity write-up.
 */
export class TaskScheduler {
  private readonly records = new Map<string, TaskRecord>();
  private readonly graph: Graph = newGraph();
  private readonly heap = new MinHeap();
  private seqCounter = 0;
  private lastSurfacedId: string | null = null;

  // ------------------------------------------------------------------ //
  //  Mutation: add                                                      //
  // ------------------------------------------------------------------ //

  /**
   * Add a task. `now` defaults to `Date.now()`; injectable for tests.
   *
   * Dependencies are validated eagerly:
   *   - self-dependency      -> SELF_DEPENDENCY
   *   - unknown dependency   -> UNKNOWN_DEPENDENCY
   *   - adding edges that form a cycle -> CYCLE_DETECTED (reported with the
   *     concrete cycle path, then rolled back so state is unchanged)
   *
   * Cycle-check cost: the check walks the reverse-reachable subgraph from
   * the new task's predecessors — the only region where the new edges can
   * create a cycle. O(reachable V + reachable E), O(1) when the region is
   * small. For a bulk load of a *known-acyclic* DAG this is near-zero per
   * task; see README "Scalability" for the load-ordering trick that makes
   * even cyclic-hostile workloads linear.
   */
  addTask(input: AddTaskInput, now: number = Date.now()): TaskRecord {
    if (this.records.has(input.id)) {
      throw new SchedulerError("DUPLICATE_TASK", `Task "${input.id}" already exists`, { id: input.id });
    }

    const deps = input.dependsOn ?? [];
    // Validate dependency ids first (cheap, fail-fast before any mutation).
    for (const d of deps) {
      if (d === input.id) {
        throw new SchedulerError("SELF_DEPENDENCY", `Task "${input.id}" depends on itself`, { id: input.id });
      }
      if (!this.records.has(d)) {
        throw new SchedulerError("UNKNOWN_DEPENDENCY", `Dependency "${d}" of "${input.id}" does not exist`, {
          id: input.id,
          dependency: d,
        });
      }
    }

    // Cycle check *before* committing anything, but only when there is at
    // least one new incoming edge. For each predecessor dep, the new edge
    // dep -> input.id creates a cycle iff input.id can reach dep in the
    // forward graph (a path input.id -> ... -> dep combined with the new
    // edge dep -> input.id closes the loop). The new edges go INTO
    // input.id, so they are irrelevant for reachability FROM it — we can
    // check on the clean graph without any tentative additions.
    // Scoped: O(forward-reachable from input.id) per dep.
    if (deps.length > 0) {
      for (const d of deps) {
        const cycle = this.forwardCycleFrom(input.id, d);
        if (cycle !== null) {
          throw new SchedulerError("CYCLE_DETECTED", `Adding "${input.id}" would create a cycle`, {
            cycle: [...cycle, d], // close the loop: input.id -> ... -> d, then new edge d -> input.id
          });
        }
      }
    }

    const seq = ++this.seqCounter;
    const record: TaskRecord = {
      id: input.id,
      priority: input.priority ?? 0,
      scheduledAt: input.scheduledAt ?? now,
      state: "QUEUED",
      seq,
      unmet: deps.length,
      successors: new Set(),
      predecessors: new Set(deps),
      payload: "payload" in input ? input.payload : undefined,
      label: input.label ?? input.id,
    };

    // Commit: graph edges, record, heap.
    // Note: the cycle-check block above added+removed tentative edges, so
    // the graph is clean. We must add the edges here unconditionally.
    // The `predecessors` Set is built from `deps` (which may have dups),
    // so we dedupe via the Set itself — but we must NOT skip addEdge based
    // on that, because the graph was cleaned by the rollback.
    const added = new Set<string>();
    for (const d of deps) {
      if (added.has(d)) continue; // true dedupe within this deps array
      added.add(d);
      addEdge(this.graph, d, input.id);
      this.records.get(d)!.successors.add(input.id);
    }
    record.unmet = added.size; // deduplicated count
    this.records.set(input.id, record);
    this.pushHeap(record);

    return record;
  }

  /**
   * Forward-reachability check on the live (clean) graph. Determines whether
   * `start` can reach `target` via the forward adjacency; if so, returns the
   * concrete path [start, ..., target], else null. Iterative BFS with an
   * index-cursor queue — O(V+E) of the forward-reachable region, no
   * recursion, safe at 1M nodes.
   *
   * Cycle-semantics: the caller is adding a new edge target -> start. That
   * edge creates a cycle iff start can reach target in the *existing* graph
   * (the new edge goes into start, so it cannot help reachability from
   * start). The returned path start -> ... -> target plus the caller's new
   * edge target -> start forms the cycle.
   */
  private forwardCycleFrom(start: string, target: string): string[] | null {
    if (start === target) return [start];
    // BFS from `start`; track parents for path reconstruction.
    const parent = new Map<string, string | null>();
    parent.set(start, null);
    const queue: string[] = [start];
    let head = 0;
    let found = false;
    while (head < queue.length) {
      const n = queue[head++]!;
      if (n === target) {
        found = true;
        break;
      }
      const outs = this.graph.adj.get(n);
      if (!outs) continue;
      for (const next of outs) {
        if (!parent.has(next)) {
          parent.set(next, n);
          queue.push(next);
        }
      }
    }
    if (!found) return null;
    // Reconstruct: target -> ... -> start, then reverse to start -> ... -> target.
    const path: string[] = [];
    let cur: string | null = target;
    while (cur !== null) {
      path.push(cur);
      cur = parent.get(cur) ?? null;
    }
    path.reverse();
    return path; // start -> ... -> target; caller appends target to close the loop
  }

  // ------------------------------------------------------------------ //
  //  Dynamic updates                                                    //
  // ------------------------------------------------------------------ //

  /**
   * Partially update a task's priority / scheduledAt / label / payload.
   * Re-inserts the heap entry if ordering keys changed. O(log n).
   * A task in RUNNING/terminal state cannot change ordering keys (the
   * heap no longer holds it); other fields are still updatable.
   */
  updateTask(id: string, updates: UpdateTaskInput): TaskRecord {
    const r = this.require(id);
    if (r.state === "CANCELLED") {
      throw new SchedulerError("NOT_UPDATABLE", `Cannot update cancelled task "${id}"`, { id });
    }
    // Ordering keys: scheduledAt, priority. seq is immutable.
    const keyChanged =
      (updates.scheduledAt !== undefined && updates.scheduledAt !== r.scheduledAt) ||
      (updates.priority !== undefined && updates.priority !== r.priority);
    const wasInHeap = r.state === "QUEUED" || r.state === "READY";

    if (updates.priority !== undefined) r.priority = updates.priority;
    if (updates.scheduledAt !== undefined) r.scheduledAt = updates.scheduledAt;
    if (updates.label !== undefined) r.label = updates.label;
    if ("payload" in updates) r.payload = updates.payload;

    if (keyChanged && wasInHeap) {
      // Evict the stale entry and push a fresh one. O(n) find + O(log n) sift.
      this.heap.remove(id);
      this.pushHeap(r);
    }
    return r;
  }

  /**
   * Add a new dependency edge: `depId` must finish before `id`.
   * Validates acyclicity and updates `unmet` accordingly. O(V+E) worst case
   * for the cycle check, O(1) bookkeeping otherwise.
   */
  addDependency(id: string, depId: string): TaskRecord {
    const r = this.require(id);
    if (depId === id) {
      throw new SchedulerError("SELF_DEPENDENCY", `Task "${id}" cannot depend on itself`, { id });
    }
    if (!this.records.has(depId)) {
      throw new SchedulerError("UNKNOWN_DEPENDENCY", `Dependency "${depId}" does not exist`, { id, dependency: depId });
    }
    if (r.predecessors.has(depId)) return r; // idempotent
    const dep = this.records.get(depId)!;

    if (r.state === "QUEUED" || r.state === "READY") {
      // New edge is depId -> id. A cycle would form iff id can reach depId
      // (a path id -> ... -> depId combined with the new edge depId -> id
      // closes the loop). So: check whether id reaches depId in the forward
      // graph (the edge isn't needed for this — it goes the other way).
      // Scoped: O(forward-reachable from id).
      const cycle = this.forwardCycleFrom(id, depId);
      if (cycle !== null) {
        throw new SchedulerError("CYCLE_DETECTED", `Adding dep "${depId}" -> "${id}" creates a cycle`, {
          cycle: [...cycle, depId], // close the loop: id -> ... -> depId, then new edge back to id
        });
      }
    }

    addEdge(this.graph, depId, id);
    r.predecessors.add(depId);
    dep.successors.add(id);
    // A *live* predecessor blocks a task that still needs its deps met —
    // QUEUED or READY. A READY task (deps previously met, surfaced by a
    // peek) must be blocked again: re-surfaced as READY it stays in the
    // heap, so bump unmet to keep nextExecutableTask honest. A SUCCEEDED
    // dep is already satisfied and must not increment unmet.
    if ((r.state === "QUEUED" || r.state === "READY") && dep.state !== "SUCCEEDED") {
      r.unmet++;
    }
    return r;
  }

  /**
   * Remove a dependency edge. Decrements `unmet` only if the predecessor was
   * *live* (not SUCCEEDED) and the task is QUEUED or READY — mirroring
   * addDependency, so a SUCCEEDED predecessor never perturbs the counter.
   * O(1).
   */
  removeDependency(id: string, depId: string): TaskRecord {
    const r = this.require(id);
    if (!r.predecessors.has(depId)) {
      return r; // idempotent
    }
    const dep = this.records.get(depId);
    removeEdge(this.graph, depId, id);
    r.predecessors.delete(depId);
    dep?.successors.delete(id);
    if ((r.state === "QUEUED" || r.state === "READY") && dep !== undefined && dep.state !== "SUCCEEDED") {
      r.unmet = Math.max(0, r.unmet - 1);
    }
    return r;
  }

  // ------------------------------------------------------------------ //
  //  Retrieval: next executable task                                    //
  // ------------------------------------------------------------------ //

  /**
   * Surface the next executable task at instant `now`. A task is
   * executable iff state is QUEUED or READY && unmet === 0 && now >=
   * scheduledAt. Surfacing a QUEUED task marks it READY. The task stays
   * in the heap until a state transition (RUNNING / SUCCEEDED /
   * CANCELLED) removes it.
   */
  nextExecutableTask(now: number = Date.now()): NextExecutable | null {
    const deferred: HeapEntry[] = [];
    for (;;) {
      const top = this.heap.peek();
      if (top === null) break;
      const r = this.records.get(top.id);
      const live = r !== undefined && (r.state === "QUEUED" || r.state === "READY");
      // Skip the most-recently-surfaced task (in flight, not yet claimed).
      if (live && top.id === this.lastSurfacedId) {
        this.heap.pop();
        deferred.push(top);
        continue;
      }
      if (live && r!.unmet === 0 && now >= r!.scheduledAt) {
        // Restore deferred entries.
        for (const d of deferred) this.heap.push(d);
        if (r!.state === "QUEUED") r!.state = "READY";
        this.lastSurfacedId = r!.id;
        return {
          id: r!.id,
          priority: r!.priority,
          scheduledAt: r!.scheduledAt,
          seq: r!.seq,
          state: r!.state,
        };
      }
      // Not-yet-due: every entry behind it is also not-yet-due (heap is
      // ordered by scheduledAt first), so stop scanning.
      if (live && now < r!.scheduledAt) {
        for (const d of deferred) this.heap.push(d);
        return null;
      }
      // unmet>0 / terminal-state record: pop and defer, keep scanning.
      this.heap.pop();
      deferred.push(top);
    }
    for (const d of deferred) this.heap.push(d);
    return null;
  }

  claimTask(now: number = Date.now()): NextExecutable | null {
    // If a task was just surfaced by nextExecutableTask, claim it.
    // Otherwise, peek for the next executable task and claim it.
    if (this.lastSurfacedId !== null) {
      const r = this.records.get(this.lastSurfacedId);
      if (r !== undefined && (r.state === "READY" || r.state === "QUEUED")) {
        this.markRunning(r.id);
        return {
          id: r.id,
          priority: r.priority,
          scheduledAt: r.scheduledAt,
          seq: r.seq,
          state: r.state,
        };
      }
    }
    const next = this.nextExecutableTask(now);
    if (next === null) return null;
    this.markRunning(next.id);
    return next;
  }

  // ------------------------------------------------------------------ //
  //  State transitions                                                  //
  // ------------------------------------------------------------------ //

  private static readonly ALLOWED: Record<TaskState, readonly TaskState[]> = {
    QUEUED: ["READY", "RUNNING", "CANCELLED"],
    READY: ["RUNNING", "SUCCEEDED", "CANCELLED", "QUEUED"],
    RUNNING: ["SUCCEEDED", "FAILED", "CANCELLED"],
    SUCCEEDED: [],
    FAILED: ["QUEUED"], // retry path
    CANCELLED: [],
  };

  /**
   * Transition a task to a new state, enforcing the state machine. On
   * SUCCEEDED, eagerly release the task's outgoing edges (decrement each
   * live successor's `unmet` and drop the edge), which is what makes
   * downstream tasks become executable. O(out-degree).
   */
  transitionTask(id: string, to: TaskState): TaskRecord {
    const r = this.require(id);
    const allowed = TaskScheduler.ALLOWED[r.state];
    if (!allowed.includes(to)) {
      throw new SchedulerError(
        "INVALID_TRANSITION",
        `Invalid transition ${r.state} -> ${to} for "${id}"`,
        { id, from: r.state, to },
      );
    }
    r.state = to;

    if (to === "SUCCEEDED") {
      this.releaseEdges(r);
      // A succeeded task leaves the heap entirely.
      this.heap.remove(r.id);
      if (this.lastSurfacedId === id) this.lastSurfacedId = null;
    } else if (to === "RUNNING" || to === "FAILED") {
      // Leave the heap: no longer a candidate for nextExecutableTask.
      this.heap.remove(r.id);
      if (this.lastSurfacedId === id) this.lastSurfacedId = null;
    }
    return r;
  }

  /** RUNNING -> SUCCEEDED. Convenience wrapper. */
  succeedTask(id: string): TaskRecord {
    return this.transitionTask(id, "SUCCEEDED");
  }

  /** RUNNING -> FAILED. Convenience wrapper. */
  failTask(id: string): TaskRecord {
    return this.transitionTask(id, "FAILED");
  }

  /** QUEUED/READY -> RUNNING. Convenience wrapper. */
  markRunning(id: string): TaskRecord {
    return this.transitionTask(id, "RUNNING");
  }

  /** Any non-terminal -> CANCELLED. Evicts from heap. O(out-degree). */
  cancelTask(id: string): TaskRecord {
    const r = this.require(id);
    if ((TERMINAL as readonly TaskState[]).includes(r.state) && r.state !== "FAILED") {
      throw new SchedulerError("INVALID_TRANSITION", `Cannot cancel from ${r.state}`, { id, from: r.state });
    }
    r.state = "CANCELLED";
    this.heap.remove(id);
    if (this.lastSurfacedId === id) this.lastSurfacedId = null;
    // Cancellation does not release edges: successors stay blocked
    // (they were depending on work that will not happen). A consumer that
    // wants to unblock them must explicitly removeDependency.
    return r;
  }

  /**
   * Re-queue a FAILED task. Recomputes `unmet` from live predecessors and
   * re-pushes to the heap. O(in-degree).
   */
  retryTask(id: string): TaskRecord {
    const r = this.require(id);
    if (r.state !== "FAILED") {
      throw new SchedulerError("INVALID_TRANSITION", `Cannot retry from ${r.state}`, { id });
    }
    r.state = "QUEUED";
    r.unmet = [...r.predecessors].filter((p) => {
      const pr = this.records.get(p);
      return pr !== undefined && pr.state !== "SUCCEEDED";
    }).length;
    // Guard against a stale entry (e.g. a previous retry that never left).
    this.heap.remove(id);
    this.pushHeap(r);
    return r;
  }

  /**
   * When a task succeeds, for each live successor: drop the edge and
   * decrement unmet. Successors stay in the heap; they become
   * surface-eligible once unmet reaches 0.
   */
  private releaseEdges(r: TaskRecord): void {
    for (const s of [...r.successors]) {
      const sr = this.records.get(s);
      if (!sr) continue;
      // Drop the edge regardless of successor state: a terminal successor
      // (SUCCEEDED/CANCELLED) no longer needs the predecessor, and a live
      // one just has one fewer unmet dep.
      removeEdge(this.graph, r.id, s);
      sr.predecessors.delete(r.id);
      r.successors.delete(s);
      if (sr.state === "QUEUED" || sr.state === "READY") {
        sr.unmet = Math.max(0, sr.unmet - 1);
      }
    }
  }

  // ------------------------------------------------------------------ //
  //  Inspection                                                         //
  // ------------------------------------------------------------------ //

  get(id: string): TaskRecord | undefined {
    return this.records.get(id);
  }

  require(id: string): TaskRecord {
    const r = this.records.get(id);
    if (!r) throw new SchedulerError("TASK_NOT_FOUND", `Task "${id}" not found`, { id });
    return r;
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  get size(): number {
    return this.records.size;
  }

  list(ids: readonly string[]): TaskRecord[] {
    return ids.map((id) => this.require(id));
  }

  /** Full cycle report over the live graph. O(V+E). */
  validateGraph(): CycleReport {
    return detectCycle(this.graph);
  }

  /** Statistics snapshot. O(V) to count states. */
  stats(): SchedulerStats {
    const byState: Record<TaskState, number> = {
      QUEUED: 0, READY: 0, RUNNING: 0, SUCCEEDED: 0, FAILED: 0, CANCELLED: 0,
    };
    let edges = 0;
    for (const s of this.graph.adj.values()) edges += s.size;
    for (const r of this.records.values()) byState[r.state]++;
    return {
      total: this.records.size,
      byState,
      pending: byState.QUEUED,
      edges,
      heapSize: this.heap.size,
    };
  }

  /** O(n) self-check: verify heap invariant + unmet consistency. */
  selfCheck(): { heapOk: boolean; unmetOk: boolean; mismatches: string[] } {
    const heapOk = this.heap.checkInvariant();
    const mismatches: string[] = [];
    for (const r of this.records.values()) {
      if (r.state !== "QUEUED" && r.state !== "READY") continue;
      const live = [...r.predecessors].filter((p) => {
        const pr = this.records.get(p);
        return pr !== undefined && pr.state !== "SUCCEEDED";
      }).length;
      if (live !== r.unmet) mismatches.push(`${r.id} (${r.state}): unmet=${r.unmet} expected=${live}`);
    }
    return { heapOk, unmetOk: mismatches.length === 0, mismatches };
  }

  // ------------------------------------------------------------------ //
  //  Internals                                                          //
  // ------------------------------------------------------------------ //

  private pushHeap(r: TaskRecord): void {
    this.heap.push({ id: r.id, scheduledAt: r.scheduledAt, priority: r.priority, seq: r.seq });
  }
}

export { MinHeap };
export { newGraph, addEdge, removeEdge, detectCycle, topoSort } from "./graph.js";
export type { Graph } from "./graph.js";
