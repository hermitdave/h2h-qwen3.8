import { TaskScheduler } from "../src/scheduler.js";
const NOW = Date.now();
const s = new TaskScheduler();
for (let i = 0; i < 200_000; i++) s.addTask({ id: `a${i}`, priority: i % 10, scheduledAt: NOW }, NOW);
// peek a few at NOW
const t1 = performance.now();
for (let i = 0; i < 100; i++) s.nextExecutableTask(NOW);
console.log("100 peeks all-due:", (performance.now() - t1).toFixed(1), "ms");
// now peek at NOW-1 (nothing due): measure cost of scanning whole heap
const t2 = performance.now();
const r = s.nextExecutableTask(NOW - 1);
console.log("1 peek nothing-due (200k heap):", (performance.now() - t2).toFixed(1), "ms, result:", r);
