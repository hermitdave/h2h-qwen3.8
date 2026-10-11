import { PriorityQueue } from '../src/heap';

describe('PriorityQueue (binary min-heap)', () => {
  function byValue(v: number[]): (a: number, b: number) => number {
    return (a, b) => a - b;
  }

  test('empty queue has size 0 and pop/peek undefined', () => {
    const q = new PriorityQueue<number>(byValue([]));
    expect(q.size).toBe(0);
    expect(q.pop()).toBeUndefined();
    expect(q.peek()).toBeUndefined();
  });

  test('pop returns values in ascending order', () => {
    const q = new PriorityQueue<number>(byValue([]));
    const inputs = [5, 1, 8, 2, 9, 3, 7, 4, 6];
    for (const v of inputs) q.insert(`k${v}`, v);
    const out: number[] = [];
    let e = q.pop();
    while (e) {
      out.push(e.value);
      e = q.pop();
    }
    expect(out).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('randomised insertion preserves ascending pop order', () => {
    const q = new PriorityQueue<number>(byValue([]));
    const N = 100_000;
    // Deterministic pseudo-random (LCG) so we don't depend on Math.random.
    let seed = 42n;
    const rand = (): number => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 62n;
      return Number(seed % 100000n) + 1;
    };
    for (let i = 0; i < N; i++) {
      const v = rand();
      q.insert(`k${i}`, v);
    }
    let prev = -1;
    for (let i = 0; i < N; i++) {
      const e = q.pop();
      expect(e).toBeDefined();
      expect(e!.value).toBeGreaterThanOrEqual(prev);
      prev = e!.value;
    }
    expect(q.size).toBe(0);
  });

  test('remove by handle removes the correct element', () => {
    const q = new PriorityQueue<number>(byValue([]));
    for (const v of [3, 1, 4, 1, 5]) q.insert(`v${v}_${Math.random()}`, v);
    q.insert('target', 2);
    expect(q.remove('target')).toBe(2);
    expect(q.remove('target')).toBeUndefined();
    const out: number[] = [];
    let e = q.pop();
    while (e) {
      out.push(e.value);
      e = q.pop();
    }
    expect(out).not.toContain(2);
    expect(out).toEqual(out.slice().sort((a, b) => a - b));
  });

  test('re-inserting an existing key replaces its value', () => {
    const q = new PriorityQueue<number>(byValue([]));
    q.insert('a', 10);
    q.insert('a', 1); // replace
    expect(q.size).toBe(1);
    expect(q.pop()!.value).toBe(1);
  });

  test('update changes the effective key ordering', () => {
    const q = new PriorityQueue<number>(byValue([]));
    q.insert('a', 100);
    q.insert('b', 50);
    q.update('a', 1); // now 'a' should pop first
    expect(q.pop()!.key).toBe('a');
    expect(q.pop()!.key).toBe('b');
  });

  test('clear empties the queue', () => {
    const q = new PriorityQueue<number>(byValue([]));
    for (let i = 0; i < 100; i++) q.insert(`k${i}`, i);
    q.clear();
    expect(q.size).toBe(0);
    expect(q.pop()).toBeUndefined();
  });

  test('handles negative and fractional keys', () => {
    const q = new PriorityQueue<number>(byValue([]));
    for (const v of [-3.5, 0.5, -0.5, 2, -10]) q.insert(`k${v}`, v);
    const out: number[] = [];
    let e = q.pop();
    while (e) {
      out.push(e.value);
      e = q.pop();
    }
    expect(out).toEqual([-10, -3.5, -0.5, 0.5, 2]);
  });
});
