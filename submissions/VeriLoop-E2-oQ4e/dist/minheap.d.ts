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
export declare class MinHeap<T> {
    /** Backing array.  Index 0 unused (1-based for clean parent/child math). */
    private items;
    /** Parallel array of insertion sequence numbers, indexed in sync with items. */
    private seq;
    /** Comparator: `a` before `b` iff `compare(a, b) < 0`. */
    private readonly compare;
    /** Number of live entries (excluding index 0). */
    private size;
    /** Next insertion sequence value. */
    private nextSeq;
    constructor(compare: (a: T, b: T) => number);
    /** O(1).  Live entry count. */
    get length(): number;
    /** O(1). */
    get isEmpty(): boolean;
    /** O(1).  Minimum element or `undefined`. */
    peek(): T | undefined;
    /**
     * O(log n).  Insert `value`.
     */
    push(value: T): void;
    /**
     * O(log n).  Remove and return the minimum, or `undefined` when empty.
     */
    pop(): T | undefined;
    /**
     * O(log n).  Replace the root with `value`, return the old root.
     * If the heap is empty, behaves like `push`.
     */
    replace(value: T): T | undefined;
    /** O(n).  Shallow copy of live entries in heap order (unsorted). Debug use. */
    toArray(): T[];
    /**
     * True iff element at `i` sorts before element at `j`.
     * Ties broken by insertion sequence (FIFO).
     */
    private lessThan;
    /** Swap two positions, keeping `items` and `seq` in sync. No allocation. */
    private swap;
    /** Sift the element at `i` down until the heap invariant holds. */
    private siftDown;
}
/**
 * Factory helper.
 */
export declare function createMinHeap<T>(compare: (a: T, b: T) => number): MinHeap<T>;
//# sourceMappingURL=minheap.d.ts.map