import { TaskScheduler } from "../src/scheduler.js";

const NOW = Date.now();

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const t0 = performance.now();
const s = new TaskScheduler();
const N = 1_000_000;
const rng = mulberry32(42);
for (let i = 0; i < N; i++) {
  s.addTask({
    id: `t${i}`,
    priority: Math.floor(rng() * 100),
    scheduledAt: NOW + Math.floor(rng() * 86_400_000),
  }, NOW);
}
const ingestMs = performance.now() - t0;
console.log(`1M ingest: ${(ingestMs / 1000).toFixed(1)}s  size=${s.size}  heap=${s.stats().heapSize}`);
console.log("heap invariant ok:", s.selfCheck().heapOk);

// 10k peeks
const t1 = performance.now();
for (let i = 0; i < 10_000; i++) s.nextExecutableTask(NOW);
console.log(`10k peeks: ${((performance.now() - t1) / 1000).toFixed(2)}s`);
