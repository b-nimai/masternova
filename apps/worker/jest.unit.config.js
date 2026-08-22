/**
 * Unit tests: pure, fast, and they must NOT need a database (CLAUDE.md §6).
 * If a service test reaches for Prisma, that is a Dependency Inversion violation —
 * fix the design, not the test.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }] },
  collectCoverageFrom: ['**/*.ts', '!**/*.module.ts', '!main.ts'],
  moduleNameMapper: { '^@masternova/(.*)$': '<rootDir>/../../../packages/$1/src' },
};
