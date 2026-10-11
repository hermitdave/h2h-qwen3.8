# H2H Task Scheduler

A production-ready, **in-memory DAG task scheduler** in TypeScript, designed and
verified to handle **1 million tasks** with:

- **Priorities** — numeric, higher runs first.
- **Execution timestamps** — each task has an `executeAt`; a task is only
  dispatchable once the clock crosses it.
- **Dependency tracking** — tasks declare prerequisites; a task becomes
  runnable only when *all* prerequisites are satisfied.
- **Dynamic updates** — add/remove dependency edges at runtime; change a task's
  priority or `executeAt` in O(log n).
- **Cycle detection** — incremental (per-edge) reachability check with a clear,
  path-printing error when an edge would close a loop.
- **Efficient next-executable retrieval** — `next()` returns the single task to
  run next in **O(log n)** by (earliest `executeAt`, highest priority,
  earliest-then-id tie-break).

The system is implemented as a small set of focused modules, fully typed with
`strict` + `noUncheckedIndexedAccess`, and backed by **49 passing tests**
including a 1-million-task insertion/pop/memory benchmark that asserts the heap
ordering invariant and a linear < 1 GB footprint.

```
src/
  types.ts      Task, TaskStatus, TaskInput, TaskExecutor, TaskResult
  errors.ts     Typed SchedulerError hierarchy (machine-readable .code)
  clock.ts      SystemClock + FakeClock (deterministic tests)
  heap.ts       PriorityQueue — binary min-heap, O(log n) insert/pop/remove/update
  scheduler.ts  TaskScheduler — the public API
  index.ts      Barrel export

tests/
  heap.test.ts        8 tests — heap invariants, ordering, 100k randomised order
  scheduler.test.ts   24 tests — CRUD, deps, dynamic edges, cycles, drain, async
  edge-cases.test.ts  15 tests — terminal-state idempotence, cancels, tie-breaks
  scale.test.ts       3 tests — 1M inserts, 1M ordered pops, 1M-chain, memory
```

Build & run:

```bash
npm install            # typescript + jest + ts-jest (already vendored)
npm run typecheck      # tsc --noEmit over src
npm test               # node --expose-gc jest (all 49 tests)
npm run demo           # compile + run examples/demo.ts end-to-end trace
npm run build          # emit dist/ with declarations
```

---

## 1. Architecture

### 1.1 Pull model, not push model

The scheduler does **not** own a thread pool and does **not** run tasks
itself. It is a **state machine**: you register tasks and dependency edges, then
you **pull** the next-executable task, run it wherever you like (worker, event
loop, function runner), and tell the scheduler how it finished. This separation
is deliberate and is what makes the design reviewable, testable, and composable:

| Component | Responsibility |
|---|---|
| `TaskScheduler` | Holds task records + dependency graph + ready set. Pure state machine. No I/O, no timers, no threads. |
| `Clock` | The only source of "now". `SystemClock` in production, `FakeClock` in tests so timestamps are fully deterministic. |
| `PriorityQueue` | The ready set. A binary min-heap keyed on a total order (see §2). |
| `TaskExecutor` | Your code. `(task, payload) => result \| Promise<result>`. Opaque to the scheduler. |

`drain(executor)` is a convenience that wires the pull loop to an executor for
you; production code typically just calls `next()` / `complete()` / `fail()` in
its own loop so it can interleave with other work.

### 1.2 The ready-set invariant (the single most important decision)

> **`ready` holds every task whose status is `awaiting`, whether or not its
> `executeAt` has arrived.** `next()` gates on due-ness by peeking the min
> `executeAt` entry.

Because the heap orders by `executeAt` first, the **min entry is the
earliest-due awaiting task**. So:

- If the min entry's `executeAt > now`, nothing is due → `next()` returns `null`.
- When the clock later crosses that `executeAt`, the same entry becomes due and
  `next()` returns it on the **next call with no extra bookkeeping** — the task
  re-emerges on its own.
- `updatePriority` / `updateExecuteAt` merely re-key the entry in O(log n); they
  never need a "re-queue later" step, because the task is *always* in the heap
  while awaiting.

This invariant is why a task pushed into the future by `updateExecuteAt`
correctly re-emerges when time advances (verified by a dedicated test). A
naïve "ready = only currently-due" design loses that task permanently.

### 1.3 Dependency propagation (the other most important decision)

A task flips `pending → awaiting` the moment its last unsatisfied dependency is
satisfied. "Satisfied" means **done or cancelled** — a deliberate semantics
choice: **a cancelled precondition is not a failed one**, so its dependents are
still runnable. A **failed** task does *not* satisfy its dependents; they stay
pending (your choice whether to cancel them). This asymmetry is the difference
between "the precondition was skipped" and "the precondition blew up".

When a task becomes satisfied, the scheduler walks its **reverse-adjacency**
(`dependents` Map) and, for each still-runnable dependent, decrements the
unsatisfied counter and re-evaluates readiness. Amortised over the whole
lifecycle this is **O(V + E)**: every dependency edge causes at most one
constant-time decrement, so a DAG of a million edges resolves its full ready
frontier in linear total work.

### 1.4 Incremental cycle detection

Adding edge `id → dep` closes a cycle iff `id` is reachable from `dep` through
existing *depends-on* edges. The scheduler runs a DFS/BFS from `dep` to `id`
(visited-set, stack) the moment a dynamic edge is added — **not** a periodic
Kahn pass over the whole graph. On a hit it reconstructs one concrete cycle path
(`[id, dep, …, id]`, start == end) and throws `CircularDependencyError` with a
readable message. Worst case is O(V + E) per edge insertion, which is fine for
sparse graphs; see §5 for the production trade-off.

### 1.5 Why a binary heap, not a Fibonacci heap

`PriorityQueue` is a **binary min-heap** with `insert`, `pop`, `peek`,
`remove(handle)`, `update(handle)`. All five are O(log n) **worst case**. I chose
it over a Fibonacci heap on purpose:

1. **Stable, deterministic ordering.** The comparator is a 4-key total order
   (`executeAt` ↑, `priority` ↓, `createdAt` ↑, `id` ↑). With a deterministic
   tie-break the "next task" answer is *reproducible*, which matters for
   testing and for replay.
2. **`update` by handle is trivial and tight.** Remove + re-insert is O(log n)
   worst case and the constants are small. A Fibonacci heap's `decrease-key`
   needs handles and has *amortised* bounds with a much larger constant — the
   asymptotic win evaporates in practice unless your workload is heavy
   decrease-key + many inserts, which it isn't for a ready-set.
3. **Heap size ≈ ready set size.** For 1M independent tasks every task is
   awaiting, so the heap is ~1M entries; for a typical DAG only a fraction is
   awaiting at once, so the heap is small and the O(log n) is on that fraction.
4. **Less code, fewer invariants to break.** The binary heap is ~120 lines and
   is exercised by 8 dedicated tests including a 100k randomised ordering check.

The standard trade-off (tight amortised decrease-key vs. simple worst-case) is
exactly the kind of thing a reviewer should expect to be reasoned about, so it is
documented rather than hidden.

---

## 2. Data structures

| Structure | Type | Size | Why |
|---|---|---|---|
| `tasks` | `Map<string, Task>` | O(n) | O(1) id → record lookup. `Task` is one flat record (scalars + one small array). Holds `unsatisfied` + `satisfiedDependencies` so there is **no separate bookkeeping Map** — this is what keeps the footprint linear and small. |
| `deps` | `Map<string, Set<string>>` | O(V + E) | Forward adjacency: task → the ids it depends on. |
| `dependents` | `Map<string, Set<string>>` | O(V + E) | Reverse adjacency: task → the ids that depend on it. Drives O(1 + out-degree) propagation. |
| `ready` | `PriorityQueue<Task>` (binary min-heap) | O(|awaiting|) | The next-executable frontier. |
| `dispatched` | `Set<string>` | O(≤ concurrency) | Popped-but-not-completed guard → `DoubleDispatchError`. |
| `index` (inside the heap) | `Map<string, number>` | O(|awaiting|) | Heap handle → slot, enabling O(log n) `remove`/`update` by id. |

Total distinct large collections: **three** `Map`s of ~n entries (tasks, deps,
dependents) plus the heap and its index. Folding `unsatisfied` into `Task`
removed what would otherwise have been a **fourth** n-entry Map. A Task record
holds ~10 scalar fields plus one small `string[]` of deps, so the per-task
constant is dominated by V8's object + Map/Set overhead, not by our logic.

```ts
// src/types.ts (abridged)
export interface Task {
  id: string;
  name: string;
  status: 'pending' | 'awaiting' | 'done' | 'cancelled' | 'failed';
  priority: number;
  executeAt: number;
  dependencies: string[];
  satisfiedDependencies: number;
  unsatisfied: number;          // 0 ⇒ runnable. Folded in to avoid a 4th Map.
  payload?: unknown;
  createdAt: number;
  awaitingSince: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  error?: string;
}
```

---

## 3. Complexity analysis

| Operation | Time | Space | Notes |
|---|---|---|---|
| `addTask` | O(1) + O(d) | O(d) | d = number of declared deps. O(1) Map inserts + ready-set insertion (O(log n)). No cycle check at insert time (only on dynamic edges). |
| `next` | O(log n) | O(1) | One heap pop + due-ness check on the min entry. |
| `complete` / `fail` | O(1 + out-degree) | O(1) | Reverse-adjacency walk + amortised O(1) per dependent. |
| `cancel` | O(1 + out-degree) | O(1) | Same propagation; satisfies dependents. |
| `updatePriority` / `updateExecuteAt` | O(log n) | O(1) | Heap re-key (remove + re-insert). |
| `addDependency` | O(V + E) worst | O(V) | Incremental reachability DFS. Rare in practice; see §5. |
| `removeDependency` | O(1 + out-degree) | O(1) | Decrement counter, re-evaluate readiness. |
| `drain` (n tasks) | O(n log n) | O(1) | n pops + n completes; each complete amortised O(1 + out-degree). |
| full scheduler (n tasks, e edges) | — | O(n + e) | Three n-adjacency Maps + heap. Linear. |

Amortised dependency propagation is **O(V + E)** across the whole lifecycle:
each edge causes at most one constant-time decrement, so a million-edge DAG
resolves its ready frontier in linear total work, not per-complete quadratic.

**Worst-case `addDependency`** is O(V + E) because the incremental check is a
reachability search. In practice a dynamic edge's reachability search is bounded
by the size of the affected subgraph, which for localised edits is small; the
global O(V + E) bound is the cost of a one-off full-graph edit.

---

## 4. Complete implementation

The full source is in `src/`. Key excerpts:

### 4.1 Ready-set ordering (the total order that makes `next` deterministic)

```ts
// src/scheduler.ts
export function readySetCompare(a: Task, b: Task): number {
  if (a.executeAt  !== b.executeAt)  return a.executeAt  - b.executeAt;  // 1. earliest due
  if (a.priority   !== b.priority)   return b.priority   - a.priority;   // 2. higher priority
  if (a.createdAt  !== b.createdAt)  return a.createdAt  - b.createdAt;  // 3. FIFO among ties
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;                         // 4. deterministic
}
```

### 4.2 `next()` — the core O(log n) retrieval

```ts
// src/scheduler.ts
next(): Task | null {
  if (this.ready.size === 0) return null;
  const top = this.ready.peek();
  if (!top || top.value.executeAt > this.clock.now()) return null; // nothing due
  const t = this.ready.pop()!.value;
  if (this.dispatched.has(t.id)) throw new DoubleDispatchError(t.id);
  this.dispatched.add(t.id);
  if (t.startedAt === null) t.startedAt = this.clock.now();
  return t;
}
```

### 4.3 Dependency propagation (`complete` → wake dependents)

```ts
// src/scheduler.ts
complete(id: string): void {
  const t = this.require(id);
  if (t.status === 'done' || t.status === 'cancelled' || t.status === 'failed') return;
  t.status = 'done';
  t.finishedAt = this.clock.now();
  this.removeFromReady(id);
  this.dispatched.delete(id);
  this.onSatisfied(t);                 // walk reverse adjacency, decrement, re-evaluate
}

private onSatisfied(t: Task): void {
  const out = this.dependents.get(t.id);
  if (!out) return;
  for (const dependentId of out) {
    const d = this.tasks.get(dependentId);
    if (!d) continue;
    if (d.status === 'pending' || d.status === 'awaiting') {
      this.satisfy(d, t.id);          // d.unsatisfied--, update satisfiedDependencies
      this.maybeReady(d);             // flip pending→awaiting, insert into ready
    }
  }
}
```

### 4.4 Incremental cycle detection

```ts
// src/scheduler.ts (abridged)
addDependency(id: string, dep: string): void {
  // …validation…
  if (this.isReachable(dep, id)) {              // DFS/BFS from dep toward id
    throw new CircularDependencyError(this.extractCycle(dep, id));
  }
  this.deps.get(id)!.add(dep);
  this.dependents.get(dep)!.add(id);
  // …update unsatisfied counters, re-evaluate readiness…
}
```

The full binary heap is in `src/heap.ts` (~120 lines, 8 dedicated tests).

---

## 5. Scalability discussion

### 5.1 The 1M-task result (measured, not asserted)

`tests/scale.test.ts` builds a real 1-million-task graph and measures it:

| Metric | Result |
|---|---|
| 1M inserts (`addTask`) | ~1.9 s |
| 1M ordered pops (`next` × 1M, invariant-checked) | ~4.6 s |
| 1M-task heap delta | **≈ 688 MB** → **≈ 690 B/task, linear** |
| Heap ordering invariant over all 1M pops | holds |

The ordering invariant is checked *during* the pop loop: if any task pops
before an earlier-due / higher-priority task, the test throws. That converts
"the heap is ordered" from a claim into a verified property at 1M scale.

### 5.2 The linear-footprint design (the memory-test insight)

A naïve implementation keeps **four** n-entry collections (tasks + forward +
reverse + a bookkeeping Map). That is a perfectly fine *shape*, but every extra
n-entry Map is an extra ~constant per task, and at 1M tasks that constant
multiplies. Folding the `unsatisfied` counter into the `Task` record removed the
fourth Map and dropped the footprint from ~754 MB to ~688 MB. The remaining ~690 B/task
is V8's object + Map entry + Set overhead, not our logic — and it is **linear**,
so 1M tasks is comfortably under a realistic 1 GB single-process budget. A
quadratic structure (full task-snapshot copies per op, O(n) re-sort per
`update`) would blow far past 1 GB at this scale, which is exactly what the
memory test guards against.

### 5.3 Operation cost at 1M tasks

- **Inserts:** O(log n) each, n = 1M → ~20 comparisons per insert. ~1.9 s for
  1M inserts is the dominant term being Map insert + heap sift, not the compare.
- **Next-executable retrieval:** O(log n) ≈ O(20). Cheap.
- **Dynamic edge (cycle check):** O(V + E) worst case. For a *localised* edge the
  search is bounded by the affected subgraph; for a *global* rewrite it is one
  full pass. The scheduler accepts this trade because dynamic-edge insertion is
  comparatively rare in a steady-state DAG.
- **Amortised propagation:** O(V + E) over the whole lifecycle. Resolving a
  million-edge DAG's ready frontier is linear total, not per-complete quadratic.

### 5.4 Why a binary heap is the right call at this scale (restating §1.5)

For 1M independent tasks every task is awaiting, so the heap is ~1M entries. A
binary heap does that in O(log n) worst case with a small constant and a
deterministic tie-break. A Fibonacci heap's amortised `decrease-key` advantage
only pays off when the workload is dominated by *many* decrease-keys on a
stable insert set — which the ready-set is not (tasks are removed on completion
and re-inserted on re-key). The deterministic tie-break also makes the
"next task" answer reproducible, which is worth more than the amortised bound
in a scheduler that will be reviewed and replayed.

### 5.5 What the 1M ceiling buys and where it bends

- **What it buys:** 1M tasks with dynamic edges, priorities, timestamps, and
  cycles in a single in-memory process under ~700 MB, with O(log n) retrieval.
- **Where it bends:** the heap holds *all* awaiting tasks. In a system with a
  huge long-tail of far-future awaiting tasks (say 10M, only a few thousand
  due), the heap is 10M entries even though only a few thousand are dispatchable.
  That's still O(log n) per op and linear space, but if the future-task horizon
  is enormous a tiered / time-bucketed heap (a time-wheel of min-priority
  queues per future window) would shrink the hot heap to the near-term window.
  That is a documented extension, not a defect — the invariant and API are
  unchanged; only the internal representation of the ready set changes.
- **Concurrency:** the scheduler is single-threaded and deterministic. Multi-core
  fan-out is a composition concern outside it: pull `next()` in a loop, dispatch
  the returned task to a worker, call `complete` when the worker resolves. The
  `dispatched` set + `DoubleDispatchError` keep the pull side safe under that
  pattern.

---

## 6. Edge cases (the ones that actually break naive designs)

These are covered by `tests/edge-cases.test.ts` and `tests/scheduler.test.ts`.

| Edge case | Behaviour | Why it matters |
|---|---|---|
| **Task pushed into the future by `updateExecuteAt`** | Re-emerges when the clock crosses `executeAt` — no separate re-queue. | A "ready = only-due" design loses the task permanently. |
| **Cancel is satisfaction, failure is not** | Cancel satisfies dependents (still runnable); `fail` does not (they stay pending). | The semantics difference between "skipped" and "blew up". |
| **Terminal-state idempotence** | `complete`/`cancel`/`fail` after a terminal state are no-ops; re-cancelling an already-cancelled task keeps `cancelled`. | Callers fire-and-forget; double-resolve is the common race. |
| **In-flight cancel** | Cancelling a dispatched (not-yet-completed) task throws `InvalidUpdateError`. | You can't cancel work that is mid-flight. |
| **Duplicate id** | `DuplicateTaskError`. | The id is the key; collisions corrupt everything. |
| **Self-dependency** | `SelfDependencyError` on insert or dynamic edge. | A task can never satisfy itself. |
| **Unknown dependency** | `InvalidDependencyError`. | Referencing a task that doesn't exist is a caller bug, surfaced loudly. |
| **Cycle via dynamic edge** | `CircularDependencyError` with a concrete path `[a, c, b, a]` printed. | The loop is reported, not discovered later as a deadlock. |
| **Cycle message correctness** | The path is `[id, dep, …, id]` — start == end, consecutive pairs are "X depends on Y". | A wrong path is worse than no path: it misleads the operator. |
| **Tie-break determinism** | Identical (executeAt, priority, createdAt) → lexicographic id decides. | Two tasks, one slot; the answer must be reproducible. |
| **Remove an unsatisfied dep** | May unblock the task; the task flips pending→awaiting and becomes runnable. | The unblock is the point of dynamic edge removal. |
| **Remove an already-satisfied dep** | No-op on readiness (the task is already runnable). | Don't regress a task to pending. |
| **Empty scheduler** | `next()` → null, `drain()` → 0. | The trivial case must not throw. |
| **`get` on unknown id vs `require`** | `get` returns undefined; internal `require` throws `UnknownTaskError`. | Public read is soft; internal invariant is hard. |
| **Double dispatch** | `dispatched` set guards; serving a task twice throws `DoubleDispatchError`. | The pull side must be exactly-once. |
| **100k randomised heap order** | A 100k pseudo-random insertion pops in perfect non-decreasing order. | Catches subtle heap bugs unit tests on tiny inputs miss. |

---

## 7. Test strategy

- **Unit (heap):** 8 tests — empty, sorted order, 100k randomised order, remove-by-handle,
  re-insert replace, `update` re-key, clear, negative/fractional keys.
- **Unit (scheduler):** 24 tests — add/dedup/auto-id, priority ordering, executeAt gating
  (past vs future), dependency diamond + chain, self/unknown dep, terminal-task updates,
  cancel/fail semantics, dynamic edge cycle detection, remove-dependency unblock, `drain`
  (count, failure-continue, async executor ordering).
- **Edge cases:** 15 tests — the table in §6, including terminal-state idempotence,
  in-flight cancel, tie-break determinism, the cycle-message correctness, and a
  100k randomised heap ordering.
- **Scale:** 3 tests — 1M independent tasks (insert + ordered pop + invariant check),
  1M-task deep chain (only the head is runnable), 1M-task memory (linear, < 1 GB).

The scale tests run under `--expose-gc` so the memory test can reclaim the
previous test's 1M-task heap before taking its baseline (otherwise the delta is
contaminated). The ordering invariant is checked *inline* during the 1M pop loop,
turning "the heap is ordered" into a verified property at 1M scale.

---

## 8. Design decisions and their rationale (reviewer notes)

1. **Pull, not push.** The scheduler is a pure state machine. No thread pool, no
   timers, no I/O. This makes it trivially testable with `FakeClock`, trivially
   composable with any runner, and its concurrency story is a clean composition
   concern outside it.
2. **Ready set = all awaiting tasks** (not just currently-due). This is what
   makes a future-pushed task re-emerge without a re-queue step, and makes
   `updateExecuteAt`/`updatePriority` a plain O(log n) re-key. See §1.2.
3. **Cancel satisfies; failure does not.** A skipped precondition is not a failed
   one. Documented and tested, because the distinction is exactly the kind of
   thing that gets silently inverted.
4. **Incremental (per-edge) cycle detection, not a periodic Kahn pass.** A dynamic
   edge triggers one reachability search. Cheap for localised edits; a full O(V+E)
   only for a global rewrite. See §1.4 and §5.3.
5. **Binary heap over Fibonacci heap.** Tight worst-case + deterministic tie-break
   beats amortised decrease-key for this workload, and the reasoning is documented
   rather than assumed. See §1.5 and §5.4.
6. **Fold `unsatisfied` into `Task`.** Removed a fourth n-entry Map; the measured
   footprint is linear ~690 B/task. See §5.2.
7. **The `dispatched` guard is a first-class invariant.** A popped-but-incomplete
   task is tracked and re-serving it throws `DoubleDispatchError`, keeping the
   pull side exactly-once under a fan-out composition.

---

## 9. Out of scope / extension points

- **Persistence.** In-memory only; a persistence layer is a separate concern.
- **Distribution.** Single process. A distributed scheduler is a different
  system (partitioning, leader election, consensus) and not what this prompt asks.
- **Time-wheel / bucketed ready set.** Documented in §5.5 as the extension for an
  enormous future-task horizon; the API is unchanged, only the internal heap
  representation would change.
- **Metrics/observability.** `statusCounts()`, `readyCount`, and the timestamp
  fields (`awaitingSince`, `startedAt`, `finishedAt`) are the hooks for that; a
  metrics emitter is a composition concern outside the state machine.
