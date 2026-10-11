import { describe, it, expect } from "vitest";
import { MinHeap } from "../src/heap.js";
import type { HeapEntry } from "../src/types.js";

function e(id: string, scheduledAt: number, priority: number, seq: number): HeapEntry {
  return { id, scheduledAt, priority, seq };
}

describe("MinHeap", () => {
  it("is empty initially", () => {
    const h = new MinHeap();
    expect(h.size).toBe(0);
    expect(h.peek()).toBeNull();
    expect(h.pop()).toBeNull();
  });

  it("orders by scheduledAt first (min first)", () => {
    const h = new MinHeap();
    h.push(e("late", 300, 0, 1));
    h.push(e("early", 100, 0, 2));
    h.push(e("mid", 200, 0, 3));
    expect(h.pop()?.id).toBe("early");
    expect(h.pop()?.id).toBe("mid");
    expect(h.pop()?.id).toBe("late");
  });

  it("ties on scheduledAt break by higher priority first", () => {
    const h = new MinHeap();
    h.push(e("low", 100, 1, 1));
    h.push(e("high", 100, 9, 2));
    h.push(e("mid", 100, 5, 3));
    expect(h.pop()?.id).toBe("high");
    expect(h.pop()?.id).toBe("mid");
    expect(h.pop()?.id).toBe("low");
  });

  it("ties on both break by earlier seq first", () => {
    const h = new MinHeap();
    h.push(e("later-created", 100, 5, 10));
    h.push(e("earlier-created", 100, 5, 3));
    expect(h.pop()?.id).toBe("earlier-created");
    expect(h.pop()?.id).toBe("later-created");
  });

  it("maintains the heap invariant after many random pushes/pops", () => {
    const h = new MinHeap();
    const rng = (n: number) => Math.floor(Math.random() * n);
    const less = (a: HeapEntry, b: HeapEntry): boolean => {
      if (a.scheduledAt !== b.scheduledAt) return a.scheduledAt < b.scheduledAt;
      if (a.priority !== b.priority) return a.priority > b.priority;
      return a.seq < b.seq;
    };
    for (let i = 0; i < 5000; i++) {
      h.push(e(`t${i}`, rng(1000), rng(10), i));
      if (!h.checkInvariant()) throw new Error("invariant violated after push");
    }
    // Pop all and verify the stream is sorted under the heap's ordering.
    let last: HeapEntry | null = null;
    while (h.size > 0) {
      const cur = h.pop()!;
      if (last !== null) {
        // cur must come after last in the total order (ties impossible:
        // scheduledAt/priority can tie but seq is unique per push).
        const ok = less(last, cur);
        expect(ok, `out of order: ${JSON.stringify(last)} -> ${JSON.stringify(cur)}`).toBe(true);
      }
      last = cur;
    }
  });

  it("rebuild() restores the invariant in linear time", () => {
    const h = new MinHeap();
    const entries: HeapEntry[] = [];
    for (let i = 0; i < 2000; i++) entries.push(e(`x${i}`, i % 97, (i * 7) % 13, i));
    h.rebuild(entries);
    expect(h.size).toBe(2000);
    expect(h.checkInvariant()).toBe(true);
    // min should be the entry with smallest (scheduledAt, -priority, seq)
    const min = entries.reduce((a, b) => {
      if (a.scheduledAt !== b.scheduledAt) return a.scheduledAt < b.scheduledAt ? a : b;
      if (a.priority !== b.priority) return a.priority > b.priority ? a : b;
      return a.seq < b.seq ? a : b;
    });
    expect(h.peek()!.id).toBe(min.id);
  });

  it("removeWhere evicts matching entries and preserves the invariant", () => {
    const h = new MinHeap();
    for (let i = 0; i < 500; i++) h.push(e(`r${i}`, i % 10, 0, i));
    const removed = h.removeWhere((x) => x.scheduledAt % 2 === 0);
    expect(h.size + removed).toBe(500);
    expect(h.checkInvariant()).toBe(true);
    for (const x of h.toArray()) expect(x.scheduledAt % 2).toBe(1);
  });
});
