/**
 * Integration tests: real Postgres + Redis via Testcontainers (CLAUDE.md §6).
 * Run serially — each suite owns its containers.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'test',
  testRegex: '.*\\.int-spec\\.ts$',
  testTimeout: 120_000,
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }] },
  moduleNameMapper: { '^@masternova/(.*)$': '<rootDir>/../../../packages/$1/src' },
};
