import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Scale tests are slow; give the whole suite room.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // Run in a single worker to keep the 1M-task memory tests meaningful.
    pool: "threads",
    poolOptions: {
      threads: { singleThread: true },
    },
  },
});
