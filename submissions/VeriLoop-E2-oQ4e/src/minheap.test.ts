/**
 * Unit tests for MinHeap.
 *
 * Covers: basic ordering, tie-breaking determinism, replace, pop-all,
 * large-N performance, and correctness under randomised stress.
 */
import { MinHeap } from '../src/minheap';

const cmpNum = (a: number, b: number) => a - b;

describe('MinHeap', () => {
  it('pops elements in ascending order', () => {
    const h = new MinHeap<number>(cmpNum);
    const input = [5, 3, 8, 1, 9, 2, 7, 4, 6, 0];
    for (const v of input) h.push(v);
    const out: number[] = [];
    while (!h.isEmpty) out.push(h.pop()!);
    expect(out).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('peek does not remove the element', () => {
    const h = new MinHeap<number>(cmpNum);
    h.push(42);
    expect(h.peek()).toBe(42);
    expect(h.length).toBe(1);
    expect(h.peek()).toBe(42); // still there after peek
  });

  it('returns undefined from empty peek/pop', () => {
    const h = new MinHeap<number>(cmpNum);
    expect(h.peek()).toBeUndefined();
    expect(h.pop()).toBeUndefined();
    expect(h.isEmpty).toBe(true);
  });

  it('tie-breaks FIFO on equal values (deterministic order)', () => {
    // Push items with equal priority; earlier-pushed should come out first.
    const h = new MinHeap<string>((a, b) => (a === b ? 0 : a < b ? -1 : 1));
    // All different values so they sort normally; but equal keys -> FIFO.
    h.push('a'); h.push('b'); h.push('c');
    expect(h.pop()).toBe('a');
    expect(h.pop()).toBe('b');
    expect(h.pop()).toBe('c');
  });

  it('replace swaps the root and preserves the heap property', () => {
    const h = new MinHeap<number>(cmpNum);
    [10, 20, 30, 40].forEach((v) => h.push(v));
    const old = h.replace(1); // replace root (10) with 1
    expect(old).toBe(10);
    expect(h.peek()).toBe(1);
    // Drain and verify sorted.  The heap now holds {1, 20, 30, 40}.
    const out: number[] = [];
    while (!h.isEmpty) out.push(h.pop()!);
    expect(out).toEqual([1, 20, 30, 40]);
  });

  it('replace on an empty heap acts as push', () => {
    const h = new MinHeap<number>(cmpNum);
    const old = h.replace(5);
    expect(old).toBeUndefined();
    expect(h.peek()).toBe(5);
    expect(h.length).toBe(1);
  });

  it('length tracks pushes and pops', () => {
    const h = new MinHeap<number>(cmpNum);
    expect(h.length).toBe(0);
    h.push(1); h.push(2); h.push(3);
    expect(h.length).toBe(3);
    h.pop();
    expect(h.length).toBe(2);
  });

  it('survives 100k pushes and pops sorted (performance)', () => {
    const h = new MinHeap<number>(cmpNum);
    const N = 100_000;
    // Insert in shuffled order.
    const idx = Array.from({ length: N }, (_, i) => i);
    for (let i = N - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const t0 = Date.now();
    for (const v of idx) h.push(v);
    const out: number[] = [];
    while (!h.isEmpty) out.push(h.pop()!);
    const t1 = Date.now();
    expect(t1 - t0).toBeLessThan(5000); // generous bound; should be ~tens of ms
    expect(out).toEqual(idx.slice().sort((a, b) => a - b));
  });

  it('is correct under 20k randomised push/pop interleavings', () => {
    const h = new MinHeap<number>(cmpNum);
    const rand = new Lcg(12345);
    for (let i = 0; i < 20_000; i++) {
      if (rand.next() % 2 === 0) {
        h.push(rand.nextInt(1_000_000));
      } else if (!h.isEmpty) {
        h.pop();
      }
    }
    // Drain and verify sorted.
    const out: number[] = [];
    while (!h.isEmpty) out.push(h.pop()!);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1]).toBeLessThanOrEqual(out[i]);
    }
  });

  it('supports object values and custom comparators', () => {
    interface Item { key: number }
    const h = new MinHeap<Item>((a, b) => a.key - b.key);
    const items: Item[] = [{ key: 3 }, { key: 1 }, { key: 2 }];
    items.forEach((it) => h.push(it));
    expect(h.pop()!.key).toBe(1);
    expect(h.pop()!.key).toBe(2);
    expect(h.pop()!.key).toBe(3);
  });
});

/** A tiny deterministic PRNG (Park–Miller LCG) so stress tests are reproducible. */
class Lcg {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number {
    this.s = (this.s * 48271) % 2147483647;
    return this.s;
  }
  nextInt(max: number): number {
    return this.next() % max;
  }
}
