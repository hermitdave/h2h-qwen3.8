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
export declare class PriorityQueue<T> {
    private heap;
    private index;
    private readonly compare;
    constructor(compare: (a: T, b: T) => number);
    get size(): number;
    /** Insert or replace an entry. O(log n). */
    insert(key: string, value: T): void;
    /** Remove and return an entry by handle, or undefined if absent. O(log n). */
    remove(key: string): T | undefined;
    /** Change an entry's value and re-key it. O(log n). No-op if key absent. */
    update(key: string, value: T): void;
    peek(): HeapEntry<T> | undefined;
    pop(): HeapEntry<T> | undefined;
    clear(): void;
    private siftUp;
    private siftDown;
    private swap;
}
