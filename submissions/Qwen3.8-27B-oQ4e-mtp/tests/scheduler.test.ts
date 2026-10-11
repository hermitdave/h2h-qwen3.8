import { describe, it, expect } from "vitest";
import { TaskScheduler, SchedulerError } from "../src/scheduler.js";

const NOW = 1_000_000;

function errOf(fn: () => unknown): SchedulerError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SchedulerError);
    return e as SchedulerError;
  }
  throw new Error("expected an error to be thrown");
}

describe("TaskScheduler — creation & validation", () => {
  it("adds a task with defaults", () => {
    const s = new TaskScheduler();
    const r = s.addTask({ id: "t1" }, NOW);
    expect(r.priority).toBe(0);
    expect(r.scheduledAt).toBe(NOW);
    expect(r.state).toBe("QUEUED");
    expect(r.unmet).toBe(0);
    expect(s.size).toBe(1);
  });

  it("rejects duplicate ids", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a" }, NOW);
    const err = errOf(() => s.addTask({ id: "a" }, NOW));
    expect(err.code).toBe("DUPLICATE_TASK");
  });

  it("rejects self-dependency", () => {
    const s = new TaskScheduler();
    const err = errOf(() => s.addTask({ id: "a", dependsOn: ["a"] }, NOW));
    expect(err.code).toBe("SELF_DEPENDENCY");
  });

  it("rejects unknown dependency", () => {
    const s = new TaskScheduler();
    const err = errOf(() => s.addTask({ id: "a", dependsOn: ["ghost"] }, NOW));
    expect(err.code).toBe("UNKNOWN_DEPENDENCY");
  });

  it("rejects a task that would create a cycle (and rolls back)", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a" }, NOW);
    s.addTask({ id: "b", dependsOn: ["a"] }, NOW);
    // a <- b (b after a). Now add "z" that b depends on AND that depends on
    // a -> creates a -> b -> z -> a? No. Let's do: a <- b, and add "z"
    // dependsOn [b], then later b dependsOn [z] via addDependency closes
    // the loop. Simpler: add c dependsOn [b], then addDependency(b, c).
    s.addTask({ id: "c", dependsOn: ["b"] }, NOW); // a<-b<-c, acyclic
    const err = errOf(() => s.addDependency("b", "c")); // c<-b<-c cycle
    expect(err.code).toBe("CYCLE_DETECTED");
    // After the failure the scheduler must be unchanged and acyclic.
    expect(s.has("z")).toBe(false);
    expect(s.validateGraph().cycle).toBeNull();
  });

  it("throws CYCLE_DETECTED with a concrete path when adding a closing edge", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a" }, NOW);
    s.addTask({ id: "b", dependsOn: ["a"] }, NOW); // a -> b
    // Closing edge: make a depend on b -> cycle a -> b -> a
    const err = errOf(() => s.addDependency("a", "b"));
    expect(err.code).toBe("CYCLE_DETECTED");
    expect(Array.isArray((err.detail as any).cycle)).toBe(true);
  });

  it("validates a healthy DAG reports null cycle", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a" }, NOW);
    s.addTask({ id: "b", dependsOn: ["a"] }, NOW);
    s.addTask({ id: "c", dependsOn: ["a", "b"] }, NOW);
    expect(s.validateGraph().cycle).toBeNull();
  });
});

describe("TaskScheduler — execution ordering", () => {
  it("returns null when empty or all blocked", () => {
    const s = new TaskScheduler();
    expect(s.nextExecutableTask(NOW)).toBeNull();
    s.addTask({ id: "a" }, NOW + 5000); // future
    expect(s.nextExecutableTask(NOW)).toBeNull();
  });

  it("respects scheduledAt: a due high-priority task beats an undue low one", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "future-high", priority: 100, scheduledAt: NOW + 10_000 }, NOW);
    s.addTask({ id: "now-low", priority: 1, scheduledAt: NOW }, NOW);
    const next = s.nextExecutableTask(NOW);
    expect(next?.id).toBe("now-low");
  });

  it("breaks ties by priority (higher first) then seq (earlier first)", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "p1", priority: 1 }, NOW);
    s.addTask({ id: "p5", priority: 5 }, NOW);
    s.addTask({ id: "p1-b", priority: 1 }, NOW); // same priority as p1, later seq
    const order: string[] = [];
    while (true) {
      const n = s.nextExecutableTask(NOW);
      if (!n) break;
      s.markRunning(n.id);
      s.succeedTask(n.id);
      order.push(n.id);
    }
    expect(order).toEqual(["p5", "p1", "p1-b"]);
  });

  it("does not return a task until all deps are succeeded", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a" }, NOW);
    s.addTask({ id: "b", dependsOn: ["a"] }, NOW);
    expect(s.nextExecutableTask(NOW)?.id).toBe("a");
    // b is blocked until a succeeds
    s.claimTask(NOW)!; // claims a
    expect(s.nextExecutableTask(NOW)).toBeNull(); // b still blocked
    s.succeedTask("a");
    expect(s.nextExecutableTask(NOW)?.id).toBe("b");
  });

  it("claims a task (markRunning) atomically and it leaves the heap", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "x" }, NOW);
    const claimed = s.claimTask(NOW);
    expect(claimed?.id).toBe("x");
    expect(s.get("x")!.state).toBe("RUNNING");
    expect(s.nextExecutableTask(NOW)).toBeNull();
  });

  it("full topological drain runs every task exactly once", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "build" }, NOW);
    s.addTask({ id: "lint", dependsOn: ["build"] }, NOW);
    s.addTask({ id: "typecheck", dependsOn: ["build"] }, NOW);
    s.addTask({ id: "test", dependsOn: ["lint", "typecheck"] }, NOW);
    const done: string[] = [];
    for (;;) {
      const n = s.claimTask(NOW);
      if (!n) break;
      done.push(n.id);
      s.succeedTask(n.id);
    }
    expect(done).toEqual(["build", "lint", "typecheck", "test"]);
  });
});

describe("TaskScheduler — dynamic updates", () => {
  it("reorders correctly when priority changes", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "low", priority: 1, scheduledAt: NOW }, NOW);
    s.addTask({ id: "high", priority: 9, scheduledAt: NOW }, NOW);
    // high is first at NOW
    expect(s.nextExecutableTask(NOW)?.id).toBe("high");
    // Raise low's priority; both still due at NOW.
    s.updateTask("low", { priority: 10 });
    expect(s.nextExecutableTask(NOW)?.id).toBe("low");
    // high remains in the heap and is still returned after low is claimed.
    s.claimTask(NOW)!; // low
    expect(s.nextExecutableTask(NOW)?.id).toBe("high");
  });

  it("delays a task by raising scheduledAt; the other task surfaces", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a", scheduledAt: NOW }, NOW);
    s.addTask({ id: "b", scheduledAt: NOW }, NOW);
    // a has earlier seq so a is first at NOW
    expect(s.nextExecutableTask(NOW)?.id).toBe("a");
    // Push a far into the future
    s.updateTask("a", { scheduledAt: NOW + 10_000 });
    // At NOW only b is due
    expect(s.nextExecutableTask(NOW)?.id).toBe("b");
    // At NOW+10_000, a resurfaces (b was already surfaced earlier; claim it)
    s.claimTask(NOW)!; // b
    expect(s.nextExecutableTask(NOW + 10_000)?.id).toBe("a");
  });

  it("addDependency blocks a previously-ready task until the new dep finishes", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a", priority: 1 }, NOW);
    s.addTask({ id: "b", priority: 5 }, NOW); // b ready, higher priority
    expect(s.nextExecutableTask(NOW)?.id).toBe("b");
    s.addDependency("b", "a"); // now b needs a
    // b is blocked (unmet 1). a is now the only executable task.
    expect(s.nextExecutableTask(NOW)?.id).toBe("a");
    s.claimTask(NOW)!; // a
    s.succeedTask("a");
    expect(s.nextExecutableTask(NOW)?.id).toBe("b");
  });

  it("removeDependency unblocks a task", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a" }, NOW);
    s.addTask({ id: "b", dependsOn: ["a"] }, NOW);
    expect(s.nextExecutableTask(NOW)?.id).toBe("a");
    s.claimTask(NOW)!; // a running
    expect(s.nextExecutableTask(NOW)).toBeNull(); // b blocked
    s.removeDependency("b", "a");
    expect(s.nextExecutableTask(NOW)?.id).toBe("b");
  });

  it("updating a cancelled task is rejected", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a" }, NOW);
    s.cancelTask("a");
    const err = errOf(() => s.updateTask("a", { priority: 5 }));
    expect(err.code).toBe("NOT_UPDATABLE");
  });
});

describe("TaskScheduler — state machine", () => {
  it("enforces valid transitions and rejects invalid ones", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a" }, NOW);
    expect(errOf(() => s.succeedTask("a")).code).toBe("INVALID_TRANSITION"); // QUEUED -> SUCCEEDED
    s.markRunning("a");
    expect(s.get("a")!.state).toBe("RUNNING");
    expect(errOf(() => s.markRunning("a")).code).toBe("INVALID_TRANSITION"); // RUNNING -> RUNNING
    s.succeedTask("a");
    expect(s.get("a")!.state).toBe("SUCCEEDED");
    expect(errOf(() => s.markRunning("a")).code).toBe("INVALID_TRANSITION"); // SUCCEEDED is terminal
  });

  it("retry re-queues a FAILED task and recomputes unmet", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a" }, NOW);
    s.addTask({ id: "b", dependsOn: ["a"] }, NOW);
    s.claimTask(NOW)!; // a
    s.failTask("a");
    expect(s.get("a")!.state).toBe("FAILED");
    // b is still blocked (a is FAILED, not SUCCEEDED)
    expect(s.nextExecutableTask(NOW)).toBeNull();
    s.retryTask("a");
    expect(s.get("a")!.state).toBe("QUEUED");
    expect(s.get("a")!.unmet).toBe(0);
    expect(s.nextExecutableTask(NOW)?.id).toBe("a");
  });

  it("cancel removes from heap but leaves successors blocked", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a" }, NOW);
    s.addTask({ id: "b", dependsOn: ["a"] }, NOW);
    s.cancelTask("a");
    expect(s.get("a")!.state).toBe("CANCELLED");
    // b still blocked because a never succeeded
    expect(s.nextExecutableTask(NOW)).toBeNull();
    // explicitly unblock
    s.removeDependency("b", "a");
    expect(s.nextExecutableTask(NOW)?.id).toBe("b");
  });
});

describe("TaskScheduler — self-check & stats", () => {
  it("selfCheck passes on a mixed workload", () => {
    const s = new TaskScheduler();
    s.addTask({ id: "a" }, NOW);
    s.addTask({ id: "b", dependsOn: ["a"], priority: 3 }, NOW);
    s.addTask({ id: "c", dependsOn: ["b"], scheduledAt: NOW + 100 }, NOW);
    s.claimTask(NOW)!; // a
    s.succeedTask("a");
    s.updateTask("c", { priority: 9 });
    const report = s.selfCheck();
    expect(report.heapOk).toBe(true);
    expect(report.unmetOk).toBe(true);
    expect(report.mismatches).toEqual([]);
    const st = s.stats();
    expect(st.total).toBe(3);
    expect(st.byState.QUEUED).toBe(2); // b, c
    expect(st.byState.RUNNING).toBe(0);
    expect(st.edges).toBe(1); // a->b removed, b->c remains
  });

  it("get/require throw TASK_NOT_FOUND for unknown ids", () => {
    const s = new TaskScheduler();
    expect(s.get("nope")).toBeUndefined();
    expect(errOf(() => s.require("nope")).code).toBe("TASK_NOT_FOUND");
  });
});
