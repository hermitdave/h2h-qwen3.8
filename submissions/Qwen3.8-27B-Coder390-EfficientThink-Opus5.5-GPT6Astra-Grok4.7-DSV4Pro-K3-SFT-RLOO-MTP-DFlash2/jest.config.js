/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  collectCoverageFrom: ['src/**/*.ts'],
  clearMocks: true,
  // Generous limits: a few tests generate 1M tasks and assert on
  // throughput / memory / latency, so they legitimately take tens of seconds.
  testTimeout: 300000,
  workerIdleMemoryLimit: '2GB',
};
