import type { HeapEntry } from "./types.js";

/**
 * Binary min-heap over `HeapEntry`, ordered by:
 *   1. scheduledAt  (earlier first)
 *   2. priority     (higher first)
 *   3. seq          (earlier-created first)
 *
 * Comparison is a *strict weak ordering* `less(a, b)` on the lexicographic
 * key (scheduledAt, -priority, seq) — exactly what the heap invariant needs.
 *
 * Entries are stored *by value* (a light 4-field copy). The authoritative
 * mutable state lives in `TaskRecord`; the heap entry is a view that the
 * scheduler re-pairs on demand.
 *
 * Complexity: push O(log n), pop O(log n), peek O(1), size O(1),
 * remove(id) O(n) worst case (linear find + O(log n) sift).
 */
export class MinHeap {
  private readonly items: HeapEntry[] = [];

  /** Number of entries currently in the heap. O(1). */
  get size(): number {
    return this.items.length;
  }

  /** The minimal entry, or null. O(1). */
  peek(): HeapEntry | null {
    return this.items[0] ?? null;
  }

  /** Check if an entry with the given id is in the heap. O(n). */
  contains(id: string): boolean {
    return this.findIndex(id) >= 0;
  }

  /**
   * Remove the minimal entry and return it, or null if empty. O(log n).
   * BLIND pop: does not validate executability — the scheduler decides.
   */
  pop(): HeapEntry | null {
    const items = this.items;
    if (items.length === 0) return null;
    const top = items[0] ?? null;
    if (top === null) return null;
    const last = items.pop();
    if (last !== undefined && items.length > 0) {
      items[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  /** Re-insert a previously popped entry. O(log n). */
  reinsert(entry: HeapEntry): void {
    this.push(entry);
  }

  /**
   * Strict weak ordering: a < b iff a sorts before b.
   * Key: (scheduledAt asc, priority desc, seq asc).
   */
  private less(a: HeapEntry, b: HeapEntry): boolean {
    if (a.scheduledAt !== b.scheduledAt) return a.scheduledAt < b.scheduledAt;
    if (a.priority !== b.priority) return a.priority > b.priority; // higher first
    return a.seq < b.seq;
  }

  private swap(i: number, j: number): void {
    const items = this.items;
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }

  /** Insert an entry. O(log n). */
  push(entry: HeapEntry): void {
    const items = this.items;
    items.push(entry);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = items[parent];
      if (p !== undefined && this.less(items[i]!, p)) {
        this.swap(i, parent);
        i = parent;
      } else {
        break;
      }
    }
  }

  /**
   * Find the index of the entry with `id`. Linear scan — O(n) worst case.
   * A binary heap is not a sorted array, so no binary search is possible
   * without an auxiliary index. In a production system at 1M scale you
   * would keep a Map<id, index> alongside the array (see README); here we
   * accept the linear cost because remove(id) is on the eviction path,
   * not the hot nextExecutableTask path.
   */
  private findIndex(id: string): number {
    const items = this.items;
    for (let j = 0; j < items.length; j++) {
      if (items[j]!.id === id) return j;
    }
    return -1;
  }

  /**
   * Remove the entry with the given id, if present. O(n) find + O(log n)
   * sift. Returns true if removed. Not on the hot path — used for updates,
   * state-transition evictions, and bulk cancellation waves.
   */
  remove(id: string): boolean {
    const i = this.findIndex(id);
    if (i < 0) return false;
    const items = this.items;
    const last = items.pop();
    if (i < items.length) {
      items[i] = last!;
      let j = i;
      // sift up
      while (j > 0) {
        const parent = (j - 1) >> 1;
        const p = items[parent]!;
        if (this.less(items[j]!, p)) {
          this.swap(j, parent);
          j = parent;
        } else break;
      }
      // sift down (the moved element may also need to go down)
      this.siftDown(j);
    }
    return true;
  }

  /**
   * Replace the heap wholesale with a fresh set of entries, rebuilding in
   * O(n) via Floyd's linear heap construction (fill array, then sift-down
   * from the last internal node). Used after mass updates.
   */
  rebuild(entries: readonly HeapEntry[]): void {
    this.items.length = 0;
    this.items.push(...entries);
    const n = this.items.length;
    for (let i = (n >> 1) - 1; i >= 0; i--) {
      this.siftDown(i);
    }
  }

  private siftDown(i: number): void {
    const items = this.items;
    const n = items.length;
    for (;;) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      if (left < n && this.less(items[left]!, items[smallest]!)) smallest = left;
      if (right < n && this.less(items[right]!, items[smallest]!)) smallest = right;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  /**
   * Remove every entry satisfying `pred`, in O(n) by single-pass filtering.
   * Bulk evictions only (cancellation waves, mass terminal transitions).
   * Returns the number removed.
   */
  removeWhere(pred: (e: HeapEntry) => boolean): number {
    let removed = 0;
    const items = this.items;
    let i = 0;
    while (i < items.length) {
      if (pred(items[i]!)) {
        const last = items.pop()!;
        if (i < items.length) {
          items[i] = last;
          this.siftDown(i);
          let j = i;
          while (j > 0) {
            const parent = (j - 1) >> 1;
            const p = items[parent]!;
            if (this.less(items[j]!, p)) {
              this.swap(j, parent);
              j = parent;
            } else break;
          }
        }
        removed++;
      } else {
        i++;
      }
    }
    return removed;
  }

  /** True when the heap invariant holds on every internal node. O(n). */
  checkInvariant(): boolean {
    const items = this.items;
    for (let i = 0; i < items.length; i++) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < items.length && this.less(items[left]!, items[i]!)) return false;
      if (right < items.length && this.less(items[right]!, items[i]!)) return false;
    }
    return true;
  }

  /** O(n) — returns a shallow copy of all entries (heap order, unsorted). */
  toArray(): HeapEntry[] {
    return this.items.slice();
  }
}
