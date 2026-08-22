/**
 * Integration tests: real Postgres + Redis via Testcontainers (CLAUDE.md §6).
 * Run serially — each suite owns its containers.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'test',
  testRegex: '.*\\.int-spec\\.ts$',
  testTimeout: 240_000,
  setupFiles: ['<rootDir>/setup-env.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }] },
  moduleNameMapper: {
    '^@masternova/(.*)$': '<rootDir>/../../../packages/$1/src',
    // packages/* are ESM source and so carry explicit .js extensions on relative
    // imports. Jest resolves them as CommonJS, where those files are .ts — strip the
    // extension rather than dual-building the packages just to run a unit test.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
