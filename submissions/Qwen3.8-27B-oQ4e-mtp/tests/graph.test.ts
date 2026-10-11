import { describe, it, expect } from "vitest";
import { newGraph, addEdge, detectCycle, topoSort, removeEdge } from "../src/graph.js";

describe("detectCycle (iterative 3-colour DFS)", () => {
  it("returns null cycle for an empty graph", () => {
    const g = newGraph();
    expect(detectCycle(g).cycle).toBeNull();
  });

  it("returns null cycle for an acyclic DAG", () => {
    const g = newGraph();
    addEdge(g, "a", "b");
    addEdge(g, "b", "c");
    addEdge(g, "a", "c"); // diamond
    const report = detectCycle(g);
    expect(report.cycle).toBeNull();
    expect(report.nodes).toBe(3);
    expect(report.edges).toBe(3);
  });

  it("detects a simple 2-node cycle and reports the path", () => {
    const g = newGraph();
    addEdge(g, "a", "b");
    addEdge(g, "b", "a");
    const report = detectCycle(g);
    expect(report.cycle).not.toBeNull();
    // cycle must start and end consistently: a -> b -> a (or b -> a -> b)
    const c = report.cycle!;
    expect(new Set(c).size).toBe(2);
    expect(c[c.length - 1]).toBe(c[0]);
  });

  it("detects a long self-loop-free cycle deep in the graph", () => {
    const g = newGraph();
    const n = 1000;
    for (let i = 0; i < n; i++) addEdge(g, `n${i}`, `n${(i + 1) % n}`); // big ring
    const report = detectCycle(g);
    expect(report.cycle).not.toBeNull();
    expect(report.cycle!.length).toBeGreaterThan(10); // a real cycle path
  });

  it("survives a 200k-node deep chain (no recursion overflow)", () => {
    const g = newGraph();
    const n = 200_000;
    for (let i = 0; i < n - 1; i++) addEdge(g, `v${i}`, `v${i + 1}`);
    const report = detectCycle(g);
    expect(report.cycle).toBeNull();
    expect(report.nodes).toBe(n);
    expect(report.edges).toBe(n - 1);
  });

  it("topoSort returns a valid ordering on a DAG and null on a cycle", () => {
    const g = newGraph();
    addEdge(g, "a", "b");
    addEdge(g, "a", "c");
    addEdge(g, "b", "d");
    addEdge(g, "c", "d");
    const order = topoSort(g);
    expect(order).not.toBeNull();
    const pos = new Map(order!.map((id, i) => [id, i]));
    expect(pos.get("a")!).toBeLessThan(pos.get("b")!);
    expect(pos.get("a")!).toBeLessThan(pos.get("c")!);
    expect(pos.get("b")!).toBeLessThan(pos.get("d")!);
    expect(pos.get("c")!).toBeLessThan(pos.get("d")!);

    addEdge(g, "d", "a"); // introduce a cycle
    expect(topoSort(g)).toBeNull();
  });

  it("removeEdge drops a back-edge and the graph becomes acyclic", () => {
    const g = newGraph();
    addEdge(g, "a", "b");
    addEdge(g, "b", "c");
    addEdge(g, "c", "a"); // cycle
    expect(detectCycle(g).cycle).not.toBeNull();
    removeEdge(g, "c", "a");
    expect(detectCycle(g).cycle).toBeNull();
  });
});
