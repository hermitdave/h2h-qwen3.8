/**
 * A binary min-heap priority queue with O(log n) insert / pop / remove /
 * update-by-handle, and stable, deterministic ordering via an injected
 * comparator. It is intentionally NOT a Fibonacci heap — see README
 * ("Why a binary heap, not a Fibonacci heap").
 *
 * Each entry is keyed by a unique handle (a task id). `update` is implemented
 * as remove + re-insert, which is the simplest correct way to change an entry's
 * sort key without rebuilding the heap, and is still O(log n) worst case.
 */
export interface HeapEntry<T> {
  key: string;
  value: T;
}

export class PriorityQueue<T> {
  private heap: HeapEntry<T>[] = [];
  private index = new Map<string, number>();
  private readonly compare: (a: T, b: T) => number;

  constructor(compare: (a: T, b: T) => number) {
    this.compare = compare;
  }

  get size(): number {
    return this.heap.length;
  }

  /** Insert or replace an entry. O(log n). */
  insert(key: string, value: T): void {
    this.remove(key);
    this.heap.push({ key, value });
    this.index.set(key, this.heap.length - 1);
    this.siftUp(this.heap.length - 1);
  }

  /** Remove and return an entry by handle, or undefined if absent. O(log n). */
  remove(key: string): T | undefined {
    const i = this.index.get(key);
    if (i === undefined) return undefined;
    const out = this.heap[i]!;
    const last = this.heap.length - 1;
    if (i !== last) {
      const lastEntry = this.heap[last]!;
      this.heap[i] = lastEntry;
      this.index.set(lastEntry.key, i);
    }
    this.heap.pop();
    this.index.delete(out.key);
    if (i < this.heap.length) {
      this.siftUp(i);
      this.siftDown(i);
    }
    return out.value;
  }

  /** Change an entry's value and re-key it. O(log n). No-op if key absent. */
  update(key: string, value: T): void {
    if (this.index.has(key)) {
      this.insert(key, value);
    }
  }

  peek(): HeapEntry<T> | undefined {
    return this.heap[0];
  }

  pop(): HeapEntry<T> | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0]!;
    const last = this.heap.length - 1;
    if (last !== 0) {
      const lastEntry = this.heap[last]!;
      this.heap[0] = lastEntry;
      this.index.set(lastEntry.key, 0);
    }
    this.heap.pop();
    this.index.delete(top.key);
    if (this.heap.length > 0) this.siftDown(0);
    return top;
  }

  clear(): void {
    this.heap = [];
    this.index.clear();
  }

  private siftUp(i: number): void {
    const a = this.heap;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = a[parent]!;
      const c = a[i]!;
      if (this.compare(c.value, p.value) < 0) {
        this.swap(parent, i);
        i = parent;
      } else {
        break;
      }
    }
  }

  private siftDown(i: number): void {
    const a = this.heap;
    const n = a.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let m = i;
      if (l < n && this.compare(a[l]!.value, a[i]!.value) < 0) m = l;
      if (r < n && this.compare(a[r]!.value, a[m]!.value) < 0) m = r;
      if (m === i) break;
      this.swap(m, i);
      i = m;
    }
  }

  private swap(a: number, b: number): void {
    const ea = this.heap[a]!;
    const eb = this.heap[b]!;
    this.heap[a] = eb;
    this.heap[b] = ea;
    this.index.set(ea.key, b);
    this.index.set(eb.key, a);
  }
}
