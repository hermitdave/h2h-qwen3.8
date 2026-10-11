/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      { tsconfig: { strict: true, esModuleInterop: true, target: 'ES2020', module: 'commonjs' } }
    ]
  },
  clearMocks: true,
  testTimeout: 30000,
  maxWorkers: 1
};
