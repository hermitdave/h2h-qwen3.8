# Qwen3.8-27B vs Its Fine-Tunes: Head-to-Head

**One base model. Two fine-tunes. The same prompt, the same harness, the same benchmark.**

Does fine-tuning Qwen3.8-27B actually improve its engineering output? This run answers that with
execution evidence rather than benchmarks on paper: three submissions to an identical production
TypeScript task, each one compiled, tested, probed adversarially, and benchmarked on a shared
workload.

The base model was re-run from a byte-identical copy of its earlier submission, so any score movement
is attributable to the fine-tune — not to harness drift.

## Final Leaderboard

| # | Model | Score /30 | Tests | tsc | 1M drain | 1M memory | Notes |
|---|-------|-----------|-------|-----|----------|-----------|-------|
| 🥇 | **VeriLoop-E2-oQ4e** | **28.5** | 104/104 ✅ | 0 err | **1.84s** | **362MB** | Fastest and leanest; 401-line README. One major bug: completed-dependency deadlock |
| 🥇 | **Qwen3.8-27B-Coder390-…-DFlash2** | **28.5** | 49/49 ✅ | 0 err | 4.08s | 664MB | 15/16 probes pass (highest); only submission to get completed-deps right. Slowest add |
| 🥉 | Qwen3.8-27B-oQ4e-mtp (base) | 26.5 | 56/56 ✅ | 0 err | not attempted | 610MB | 6 confirmed defects; O(n²) drain path |

Scoring: six categories × 5 points (completeness, correctness, production-readiness, test coverage,
edge cases, scalability). Full per-model analysis with every bug trace and raw probe output:
[RESULTS.md](RESULTS.md).

## The Headline: Both Fine-Tunes Beat the Base Model, and They Beat It the Same Way

Both fine-tunes independently replace the base model's O(n) linear-scan `heap.remove()` with an
O(log n) handle-based structure, turning an O(n²) drain into a linear one. The base model is not
merely slower — it needs **31.7 seconds** to drain 100,000 tasks where the fine-tunes need 0.1–0.2
seconds.

| Workload | Base | Coder390 | VeriLoop-E2 |
|---|---|---|---|
| 1M add | **0.78s** (1289k ops/s) | 1.88s (532k ops/s) | 0.80s (1245k ops/s) |
| 1M `heapUsed` | 610MB | 664MB | **362MB** |
| 10k retrieve | 0.001s | 0.015s | 0.001s |
| 50k all-due drain | 7.96s (6k ops/s) | 0.09s (541k ops/s) | **0.04s** (1207k ops/s) |
| 100k diamond drain | 31.7s | 0.2s | **0.1s** |
| 1M full drain | not attempted | 4.08s (245k ops/s) | **1.84s** (544k ops/s) |

The two fine-tunes take different routes to the same fix:

- **VeriLoop-E2** uses version-stamped lazy deletion with a two-heap (run/deferred) timer-wheel
  promotion. `peekNext` is O(1); stale entries are discarded on pop; `complete` never touches the heap.
- **Coder390** uses a position-map heap — a `Map<id, slot>` handle index giving genuine O(log n)
  `remove` and `update` by id.

## No Model Is Clean: Cross-Model Correctness

Each submission fails on something different, which is the most interesting result of the run.

| Case | Base | VeriLoop-E2 | Coder390 |
|---|---|---|---|
| Dependency on an already-COMPLETED task | ✓ | **✗ silently deadlocks** | **✓** |
| Cancel an in-flight task | ✗ allowed, orphans it | allowed | **✓ rejected** |
| Repeated peek is idempotent | ✗ rotates (`a,b,a`) | **✓** | **✓** |
| Update while RUNNING re-schedules | ✗ | **✓** | **✓** |
| Cycle via post-hoc dependency edit | **✗ creates a real cycle** | **✓ rejected** | **✓ rejected** |

The base model's failures are the most serious in kind: `claimTask()` hands out blocked tasks, and a
genuine dependency cycle can be created by calling `addDependency()` on a running task — the guard is
gated on `QUEUED || READY` and silently skipped for every other live state.

## Why the Tie at 28.5 Is Real

The two fine-tunes tie on total but are not equivalent, and the tie is a genuine trade rather than a
scoring artifact:

| | VeriLoop-E2 | Coder390 |
|---|---|---|
| Tests | **104/104** | 49/49 |
| Reviewer probes passed | 8/10 | **15/16** |
| 1M add | **0.80s** | 1.88s |
| 1M memory | **362MB** | 664MB |
| 1M drain | **1.84s** | 4.08s |
| Completed-dep case | ✗ deadlocks | **✓ correct** |
| In-flight cancel | allowed | **✓ rejected** |
| Error classes | 5 | **9** |
| README | 401 lines | **445 lines** |

**VeriLoop-E2 wins on raw engineering** — faster, leaner, more than twice the test coverage.
**Coder390 wins on correctness under adversarial probing** — the only submission that handles the
completed-dependency case, the only one that rejects in-flight cancellation, and the strongest
production surface (nine typed error classes, injectable clock, executor abstraction, per-task
lifecycle timestamps).

For production, Coder390's correctness and operational edge slightly outweigh VeriLoop's performance
lead — but VeriLoop is one bug fix away from being clearly ahead.

## Key Findings

**1. Fine-tuning fixed the architectural weakness, not the edge cases.** Both fine-tunes converged on
the same scalability fix (O(log n) handle-based heap removal) and both are dramatically faster than
the base. Neither eliminated correctness bugs — they just moved them to different places.

**2. Speed of generation did not predict quality.** The base model took 8 hours and 22.26M prefill
tokens; VeriLoop-E2 took 2.5 hours on 3.71M prefill. The faster, cheaper run produced the better
engineering artifact on every axis except one.

**3. The base model's own tests gave false confidence.** All 56 passed, yet six real defects reproduce
under targeted probes. A green suite tests the paths the model already got right — the base model's
`selfCheck()` even returns `heapOk: true, unmetOk: true` on a state where a QUEUED task has no heap
entry, unable to detect the invariant violation it exists to detect.

**4. One bug class recurs across the whole field.** Cycle creation through post-hoc dependency edits
has now been flagged in five separate models across these runs. Models reliably guard the insert path
and forget the update path.

**5. Benchmark figures are worthless without load discipline.** An intermediate run of this review
recorded the base model's diamond drain at 73.5s (vs 31.7s clean) and one test failure, purely from
machine load — Microsoft Defender at 275% CPU, oMLX at 33%. Every figure published here was measured
on an idle machine with load average recorded either side.

## Serving Statistics

| Model | Duration | Prefill | Cached | Cache Eff. | Avg TPS | Gen TPS |
|-------|----------|---------|--------|-----------|---------|---------|
| VeriLoop-E2-oQ4e | 2.5h | 3.71M | 3.60M | 97.1% | 143.7 | 16.6 |
| Qwen3.8-27B-Coder390-…-DFlash2 | 2.45h | 5.47M | 5.32M | 97.1% | 92.6 | 18.0 |
| Qwen3.8-27B-oQ4e-mtp (base) | 8h | 22.26M | 21.16M | 95.0% | 74.6 | 12.6 |

## The Prompt

> Design and implement a production-ready in-memory task scheduler using TypeScript supporting 1
> million tasks with priorities, execution timestamps, dependency tracking, dynamic updates, cycle
> detection, and efficient retrieval of the next executable task. Your answer must include:
> architecture, data structures, complexity analysis, complete implementation, tests, edge cases,
> scalability discussion. Do not simplify the problem. Assume this system will be deployed in
> production and your design choices will be reviewed by senior engineers.

Full text: [PROMPT.md](PROMPT.md)

## Repository Layout

```
├── RESULTS.md          # Full analysis: scores, bug traces, raw probe output, benchmarks
├── PROMPT.md           # The exact prompt every model received
└── submissions/        # Each model's output, verbatim (node_modules stripped)
    ├── Qwen3.8-27B-oQ4e-mtp/                  # base model
    ├── VeriLoop-E2-oQ4e/                      # fine-tune
    └── Qwen3.8-27B-Coder390-EfficientThink-Opus5.5-GPT6Astra-Grok4.7-DSV4Pro-K3-SFT-RLOO-MTP-DFlash2/
```

## Methodology

- **One model at a time** on a dedicated local oMLX server — no concurrent execution.
- **Baseline integrity check:** `diff -rq` against the base model's original submission before any
  testing, proving the artifact under review is the same code. Byte-identical (exit 0).
- **Own suite first:** each model's test runner invoked as shipped, fixing nothing.
- **Typecheck:** `tsc --noEmit` where TypeScript is claimed; errors counted with `grep -c "error TS"`.
- **Reviewer-authored probes:** targeted test files written by the reviewer to test the claims each
  model made — the completed-dependency case, in-flight cancellation, peek idempotence, post-hoc cycle
  creation, terminal-state consistency. Run against unmodified code, then deleted and the submission
  re-diffed to prove restoration.
- **Benchmark:** 1M add, 10k retrieve, 50k drain (3 trials, median), 100k diamond drain and 1M full
  drain on a workload identical across all three models, with `heapUsed` captured after forced GC.
- **Load discipline:** timing figures are only valid on an idle machine. Load average is recorded
  before and after every run; any figure measured under load is discarded and re-measured.
- **Scoring:** six categories × 5 points, judged on execution evidence rather than documentation.

## Credits

- **Benchmark design, execution, code review, scoring:** [Hermes Agent](https://hermes-agent.nousresearch.com/) (Coder Reviewer persona) — every test run, probe, benchmark and bug trace in RESULTS.md was produced by actually executing the submissions.
- **Run orchestration, serving stats, model selection:** hermitdave
- **All inference:** local models on Apple Silicon via oMLX — no cloud APIs were used.
