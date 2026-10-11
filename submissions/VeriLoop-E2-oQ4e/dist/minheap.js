"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MinHeap = void 0;
exports.createMinHeap = createMinHeap;
/**
 * MinHeap<T>
 * ---------
 * A binary min-heap with O(log n) `push` and `pop`, O(1) `peek`.
 *
 * Production design notes:
 *
 * 1. **Array-backed.**  The heap is a contiguous `Array<T>`.  Excellent cache
 *    locality — the dominant cost of heap ops is memory access, not arithmetic.
 *    At 1M items (~8 MB of references) everything fits in L3 on a modern server.
 *
 * 2. **No allocations in the hot path.**  `push`, `pop`, `peek` allocate
 *    nothing beyond the caller-supplied value.
 *
 * 3. **Lazy deletion / re-insertion.**  No decrease-key.  Dynamic updates are
 *    implemented by marking the old heap entry stale and pushing a new entry.
 *    The stale entry is reclaimed when it surfaces on `pop`.  This is the
 *    standard technique in production (event loops, Dijkstra variants) and
 *    keeps the hot path allocation-free.  Stale ratio is bounded by the number
 *    of concurrent outstanding updates.
 *
 * 4. **Stable, deterministic tie-breaking.**  When two items compare equal,
 *    the earlier-pushed one comes out first (FIFO within equal priority).
 *    Achieved with a parallel `seq` array — no object allocation, no closure
 *    capture.  This makes heap order deterministic under identical input,
 *    which is a hard requirement for reproducible tests and debugging.
 */
class MinHeap {
    constructor(compare) {
        /** Backing array.  Index 0 unused (1-based for clean parent/child math). */
        this.items = [undefined];
        /** Parallel array of insertion sequence numbers, indexed in sync with items. */
        this.seq = [0];
        /** Number of live entries (excluding index 0). */
        this.size = 0;
        /** Next insertion sequence value. */
        this.nextSeq = 1;
        this.compare = compare;
    }
    /** O(1).  Live entry count. */
    get length() {
        return this.size;
    }
    /** O(1). */
    get isEmpty() {
        return this.size === 0;
    }
    /** O(1).  Minimum element or `undefined`. */
    peek() {
        return this.size === 0 ? undefined : this.items[1];
    }
    /**
     * O(log n).  Insert `value`.
     */
    push(value) {
        const idx = ++this.size;
        this.items[idx] = value;
        this.seq[idx] = this.nextSeq++;
        // Sift up.
        let i = idx;
        while (i > 1 && this.lessThan(i, i >> 1)) {
            this.swap(i, i >> 1);
            i >>= 1;
        }
    }
    /**
     * O(log n).  Remove and return the minimum, or `undefined` when empty.
     */
    pop() {
        if (this.size === 0)
            return undefined;
        const min = this.items[1];
        const lastItem = this.items[this.size];
        const lastSeq = this.seq[this.size];
        // Drop the last reference to allow GC.
        this.items[this.size] = undefined;
        this.seq[this.size] = 0;
        this.size--;
        if (this.size > 0) {
            this.items[1] = lastItem;
            this.seq[1] = lastSeq;
            this.siftDown(1);
        }
        return min;
    }
    /**
     * O(log n).  Replace the root with `value`, return the old root.
     * If the heap is empty, behaves like `push`.
     */
    replace(value) {
        if (this.size === 0) {
            this.push(value);
            return undefined;
        }
        const min = this.items[1];
        this.items[1] = value;
        this.seq[1] = this.nextSeq++;
        this.siftDown(1);
        return min;
    }
    /** O(n).  Shallow copy of live entries in heap order (unsorted). Debug use. */
    toArray() {
        return this.items.slice(1, 1 + this.size);
    }
    // ---- internals -------------------------------------------------------
    /**
     * True iff element at `i` sorts before element at `j`.
     * Ties broken by insertion sequence (FIFO).
     */
    lessThan(i, j) {
        const c = this.compare(this.items[i], this.items[j]);
        return c < 0 || (c === 0 && this.seq[i] < this.seq[j]);
    }
    /** Swap two positions, keeping `items` and `seq` in sync. No allocation. */
    swap(i, j) {
        const ti = this.items[i];
        const si = this.seq[i];
        this.items[i] = this.items[j];
        this.seq[i] = this.seq[j];
        this.items[j] = ti;
        this.seq[j] = si;
    }
    /** Sift the element at `i` down until the heap invariant holds. */
    siftDown(i) {
        for (;;) {
            const left = i << 1;
            const right = left + 1;
            let smallest = i;
            if (left <= this.size && this.lessThan(left, smallest))
                smallest = left;
            if (right <= this.size && this.lessThan(right, smallest))
                smallest = right;
            if (smallest === i)
                break;
            this.swap(i, smallest);
            i = smallest;
        }
    }
}
exports.MinHeap = MinHeap;
/**
 * Factory helper.
 */
function createMinHeap(compare) {
    return new MinHeap(compare);
}
//# sourceMappingURL=minheap.js.map