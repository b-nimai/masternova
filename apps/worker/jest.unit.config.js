/**
 * Unit tests: pure, fast, and they must NOT need a database (CLAUDE.md §6).
 * If a service test reaches for Prisma, that is a Dependency Inversion violation —
 * fix the design, not the test.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.tsx?$',
  passWithNoTests: true,
  transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }] },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json', 'node'],
  collectCoverageFrom: ['**/*.ts', '!**/*.module.ts', '!main.ts'],
  moduleNameMapper: {
    // The subpath export must be mapped before the catch-all, or it resolves to
    // `packages/db/unit-of-work/src`, which does not exist.
    '^@masternova/db/unit-of-work$': '<rootDir>/../../../packages/db/src/unit-of-work',
    '^@masternova/(.*)$': '<rootDir>/../../../packages/$1/src',
    // packages/* are ESM source and so carry explicit .js extensions on relative
    // imports. Jest resolves them as CommonJS, where those files are .ts — strip the
    // extension rather than dual-building the packages just to run a unit test.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
