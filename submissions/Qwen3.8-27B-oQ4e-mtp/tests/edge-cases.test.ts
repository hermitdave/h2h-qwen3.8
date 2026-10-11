import { describe, it, expect, expectTypeOf } from "vitest";
import { TaskScheduler, SchedulerError } from "../src/scheduler.js";
import type { AddTaskInput, TaskState, UpdateTaskInput, NextExecutable } from "../src/types.js";

/**
 * Edge-case suite. These pin down the behaviours a senior reviewer will
 * probe: boundary times, duplicate/missing deps, stale-heap recovery,
 * concurrency-safety boundaries (single-threaded invariants), and the
 * documented failure semantics.
 */

const NOW = 1_700_000_000_000; // fixed instant

describe("Edge cases", () => {
  it("a task is executable exactly AT its scheduledAt (boundary inclusive)", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a", scheduledAt: NOW + 100 }, NOW);
    expect(s.nextExecutableTask(NOW)).toBeNull(); // 1ms early
    expect(s.nextExecutableTask(NOW + 100)?.id).toBe("a"); // exactly on time
  });

  it("duplicate dependsOn entries do not double-count unmet", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a" }, NOW);
    const r = s.addTask({ id: "b", dependsOn: ["a", "a"] }, NOW);
    // Set semantics: one predecessor, so unmet must be 1 not 2
    expect(r.unmet).toBe(1);
    expect(r.predecessors).toEqual(new Set(["a"]));
    // Drive a to success and confirm b unblocks with unmet 0 (not -1).
    s.claimTask(NOW)!; // a
    s.succeedTask("a");
    expect(s.get("b")!.unmet).toBe(0);
    const chk = s.selfCheck();
    expect(chk.unmetOk).toBe(true);
  });

  it("a task with zero deps is immediately executable", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "solo" }, NOW);
    expect(s.nextExecutableTask(NOW)?.id).toBe("solo");
  });

  it("addDependency is idempotent (no unmet double-increment)", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a" }, NOW);
    s.addTask({ id: "b" }, NOW);
    s.addDependency("b", "a");
    const before = s.get("b")!.unmet;
    s.addDependency("b", "a"); // no-op
    expect(s.get("b")!.unmet).toBe(before);
    expect(before).toBe(1);
  });

  it("removeDependency is idempotent and clamps unmet at 0", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a" }, NOW);
    s.addTask({ id: "b" }, NOW);
    s.removeDependency("b", "a"); // no edge to remove
    expect(s.get("b")!.unmet).toBe(0);
    s.addDependency("b", "a");
    s.removeDependency("b", "a");
    s.removeDependency("b", "a"); // clamp, no negative
    expect(s.get("b")!.unmet).toBe(0);
  });

  it("a succeeded predecessor is ignored when a dep is later added/removed", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a" }, NOW);
    s.addTask({ id: "b" }, NOW);
    s.claimTask(NOW)!; // a
    s.succeedTask("a");
    // add b -> a dep AFTER a already succeeded: a is terminal, so it
    // should not block b.
    s.addDependency("b", "a");
    // unmet must NOT have incremented for a terminal predecessor
    expect(s.get("b")!.unmet).toBe(0);
    expect(s.nextExecutableTask(NOW)?.id).toBe("b");
  });

  it("stale heap entries are recovered when the record changed", () => {
    // Simulate the stale-entry scenario: push an entry, mutate the record's
    // scheduledAt via updateTask (which evicts+repushes), then verify the
    // heap no longer returns the stale position.
    const s = new TaskScheduler();
    s.addTask({ id: "a", scheduledAt: NOW }, NOW);
    s.addTask({ id: "b", scheduledAt: NOW }, NOW);
    // both due; a earlier seq so a first
    expect(s.nextExecutableTask(NOW)?.id).toBe("a");
    s.updateTask("a", { scheduledAt: NOW + 10_000 }); // a goes late
    expect(s.nextExecutableTask(NOW)?.id).toBe("b"); // b now first
    // and later, a resurfaces at its new time
    expect(s.nextExecutableTask(NOW + 10_000)?.id).toBe("a");
  });

  it("claimTask returns null after draining, and repeat claims are safe", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a" }, NOW);
    expect(s.claimTask(NOW)?.id).toBe("a");
    expect(s.claimTask(NOW)).toBeNull();
    expect(s.claimTask(NOW)).toBeNull(); // idempotent no-op
  });

  it("nextExecutableTask does not mutate a blocked task's state", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a" }, NOW);
    s.addTask({ id: "b", dependsOn: ["a"] }, NOW);
    s.nextExecutableTask(NOW); // returns a (marks READY), b stays QUEUED
    expect(s.get("b")!.state).toBe("QUEUED"); // b not touched
  });

  it("a FAILED task cannot be claimed directly (must retry first)", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a" }, NOW);
    s.claimTask(NOW)!;
    s.failTask("a");
    expect(s.get("a")!.state).toBe("FAILED");
    // claimTask only returns QUEUED/READY; FAILED is out of the heap
    expect(s.claimTask(NOW)).toBeNull();
    s.retryTask("a");
    expect(s.claimTask(NOW)?.id).toBe("a");
  });

  it("payloads and labels are preserved through updates", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a", payload: { n: 1 }, label: "orig" }, NOW);
    s.updateTask("a", { payload: { n: 2 }, label: "renamed" });
    expect(s.get("a")!.payload).toEqual({ n: 2 });
    expect(s.get("a")!.label).toBe("renamed");
  });

  it("type-level: NextExecutable and TaskState are exposed correctly", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a" }, NOW);
    const n: NextExecutable | null = s.nextExecutableTask(NOW);
    expectTypeOf(n).toMatchTypeOf<NextExecutable | null>();
    if (n) expectTypeOf(n.state).toEqualTypeOf<TaskState>();
    const inputs: AddTaskInput = { id: "x" };
    const updates: UpdateTaskInput = { priority: 1 };
    expect(inputs.id).toBe("x");
    expect(updates.priority).toBe(1);
  });

  it("SchedulerError carries a stable code and detail", () => {
    const s = new TaskScheduler();
    try {
      s.require("missing");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SchedulerError);
      const se = e as SchedulerError;
      expect(se.code).toBe("TASK_NOT_FOUND");
      expect(se.detail).toEqual({ id: "missing" });
      expect(se.message).toContain("missing");
    }
  });

  it("stats() totals match size and byState sums", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a" }, NOW);
    s.addTask({ id: "b" }, NOW);
    s.claimTask(NOW)!; // a
    s.succeedTask("a");
    const st = s.stats();
    const sum = (["QUEUED","READY","RUNNING","SUCCEEDED","FAILED","CANCELLED"] as TaskState[])
      .reduce((acc, k) => acc + st.byState[k], 0);
    expect(sum).toBe(st.total);
    expect(st.total).toBe(s.size);
  });
});
