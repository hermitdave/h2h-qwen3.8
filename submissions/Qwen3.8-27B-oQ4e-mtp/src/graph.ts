import type { CycleReport } from "./types.js";

/**
 * Dependency graph adjacency + cycle detection.
 *
 * Two representations coexist and are kept in sync by the scheduler:
 *   - `adj: Map<id, Set<id>>`  — outgoing edges (predecessor -> successor)
 *   - `radj: Map<id, Set<id>>` — incoming edges (successor -> predecessor)
 *
 * `unmet` (in-degree of *live* predecessors) is maintained incrementally
 * in the record itself so that "is this task executable?" is an O(1)
 * check (`unmet === 0 && now >= scheduledAt`).
 *
 * Cycle detection uses an iterative 3-colour DFS (WHITE/GRAY/BLACK) so it
 * never recurses — critical at 1M nodes where the default stack would
 * overflow. When a back-edge is found we reconstruct the concrete cycle
 * path for the report rather than just flagging a boolean.
 *
 * Complexity: O(V + E) time, O(V + E) space.
 */

const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

export interface Graph {
  adj: Map<string, Set<string>>;
  radj: Map<string, Set<string>>;
}

export function newGraph(): Graph {
  return { adj: new Map(), radj: new Map() };
}

export function ensureNode(g: Graph, id: string): void {
  if (!g.adj.has(id)) g.adj.set(id, new Set());
  if (!g.radj.has(id)) g.radj.set(id, new Set());
}

/** Add edge a -> b (a must precede b). Idempotent. O(1) amortised. */
export function addEdge(g: Graph, a: string, b: string): void {
  ensureNode(g, a);
  ensureNode(g, b);
  g.adj.get(a)!.add(b);
  g.radj.get(b)!.add(a);
}

/** Remove edge a -> b. Idempotent. O(1) amortised. */
export function removeEdge(g: Graph, a: string, b: string): void {
  const out = g.adj.get(a);
  const inp = g.radj.get(b);
  out?.delete(b);
  inp?.delete(a);
}

/**
 * Iterative 3-colour DFS cycle detection. Returns a CycleReport. O(V+E).
 * Never recurses, so it is safe on graphs with 1M+ nodes and deep chains.
 *
 * Implementation note: the recursion is simulated with an explicit stack,
 * and the neighbour "iterator" is an explicit cursor index (NOT a `for..of`
 * over the Set). The naïve `for (const next of frame.it)` form re-scans the
 * Set from its beginning on every resume, so after a deep recursion returns
 * the parent re-visits its already-processed neighbours; the FIRST back-edge
 * it re-sees can be a STALE ancestor edge (the current DFS node is no longer
 * an ancestor of that neighbour), producing a false-negative for real
 * cycles elsewhere in the graph. An explicit cursor preserves the exact
 * iterator position of a recursive DFS, so detection is correct.
 */
export function detectCycle(g: Graph, nodeIds?: readonly string[]): CycleReport {
  const ids = nodeIds ?? [...g.adj.keys()];
  const color = new Map<string, number>();
  // Stack frames carry a path cursor, not a path copy: path[] is a single
  // shared array whose length tracks stack depth. That keeps DFS O(V + E)
  // with no per-level allocation.
  const stack: Array<{ node: string; adj: string[]; idx: number }> = [];
  const path: string[] = [];
  let cycle: string[] | null = null;

  const push = (node: string): void => {
    color.set(node, GRAY);
    path.push(node);
    stack.push({ node, adj: [...(g.adj.get(node) ?? [])], idx: 0 });
  };

  for (const start of ids) {
    if (color.get(start) === BLACK) continue;
    if (color.get(start) === undefined) push(start);

    while (stack.length > 0 && cycle === null) {
      const frame = stack[stack.length - 1]!;
      if (frame.idx < frame.adj.length) {
        const next = frame.adj[frame.idx++]!;
        const c = color.get(next) ?? WHITE;
        if (c === WHITE) {
          push(next);
        } else if (c === GRAY) {
          // Back-edge to an ancestor currently on the DFS path -> cycle.
          // Reconstruct the concrete cycle from the shared path array.
          const idx = path.indexOf(next);
          cycle = idx >= 0 ? [...path.slice(idx), next] : [frame.node, next];
        }
        // BLACK: fully explored, skip
      } else {
        color.set(frame.node, BLACK);
        stack.pop();
        path.pop();
      }
    }
    if (cycle !== null) break;
  }

  let edges = 0;
  for (const s of g.adj.values()) edges += s.size;

  return { cycle, nodes: ids.length, edges };
}

/**
 * Kahn's topological sort (iterative, using an explicit stack to avoid
 * recursion limits). Returns an ordering in which every node appears after
 * all of its predecessors, or null if the graph contains a cycle.
 * O(V + E).
 */
export function topoSort(g: Graph, nodeIds?: readonly string[]): string[] | null {
  const ids = nodeIds ?? [...g.adj.keys()];
  const indeg = new Map<string, number>();
  for (const id of ids) {
    indeg.set(id, g.radj.get(id)?.size ?? 0);
  }
  const order: string[] = [];
  const stack: string[] = [];
  for (const id of ids) {
    if ((indeg.get(id) ?? 0) === 0) stack.push(id);
  }
  while (stack.length > 0) {
    const node = stack.pop()!;
    order.push(node);
    for (const next of g.adj.get(node) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, d);
      if (d === 0) stack.push(next);
    }
  }
  if (order.length !== ids.length) return null; // cycle
  return order;
}
