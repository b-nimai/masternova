// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

/**
 * Flat config. Loom had `lint` scripts and no ESLint config at all — this is Phase 0
 * task 0.4, and it exists mainly to make ADR-0001's module boundaries mechanical rather
 * than aspirational.
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // CommonJS tooling files (jest configs) — `module` is a legitimate global there.
  {
    files: ['**/*.config.js', '**/jest.*.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
  },

  // Config files legitimately require() plugins (e.g. tailwindcss-animate).
  {
    files: ['**/*.config.ts', '**/*.config.mjs', '**/*.config.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  /* A domain exception or an HttpException carries a status code and lands in the
   * AllExceptionsFilter envelope; a bare Error does not (CLAUDE.md §4).
   *
   * Scoped to the API's request path only, and the scope has been narrowed twice by
   * the rule firing where it did not belong:
   *
   *   - Boot-time code (src/config/** validating env, src/main.ts) has no request to
   *     answer and no filter mounted yet.
   *   - apps/web has no request path at all.
   *   - apps/worker is a poll loop and a queue consumer. Nothing there returns an HTTP
   *     response, so there is no envelope to shape and a plain Error is correct.
   *   - Tests throw to simulate failure; that is the point of the test.
   *
   * A lint rule that cries wolf gets disabled, which is worse than not having it. It
   * has also earned its keep: it caught the Google OAuth callback passing a bare Error
   * to Passport, which is a real request path.
   */
  {
    files: ['apps/api/src/**/*.ts'],
    ignores: [
      'apps/api/src/config/**',
      'apps/api/src/main.ts',
      '**/*.spec.ts',
      '**/*.int-spec.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Error']",
          message:
            'Never `throw new Error(...)` on a request path. Throw a domain exception from common/exceptions/ or a Nest HttpException so AllExceptionsFilter can shape the response.',
        },
      ],
    },
  },

  /* ── The module-boundary rule (ADR-0001, CLAUDE.md §4) ─────────────────────
   * A module may import its own internals and `packages/*`. It may NOT reach into
   * another module's folder. Cross-module access goes through the public interface
   * in @masternova/contracts, or through a domain event.
   *
   * This is the rule that stops "modular monolith" from quietly becoming "monolith".
   */
  {
    files: ['apps/api/src/**/*.ts', 'apps/worker/src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'module', pattern: 'apps/*/src/modules/*', capture: ['app', 'moduleName'] },
        { type: 'shared-infra', pattern: 'apps/*/src/(common|config|prisma|types)/**' },
        { type: 'root', pattern: 'apps/*/src/(main|app.module).ts' },
      ],
      'boundaries/include': ['apps/**/*.ts'],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            {
              from: ['module'],
              allow: [['module', { moduleName: '${from.moduleName}' }], 'shared-infra'],
              message:
                'Cross-module internal import. A module may only see another module through its public interface in @masternova/contracts, or through a domain event. If you need the internals, the boundary is in the wrong place — fix the boundary (CLAUDE.md §4, ADR-0001).',
            },
            { from: ['root'], allow: ['module', 'shared-infra'] },
            { from: ['shared-infra'], allow: ['shared-infra'] },
          ],
        },
      ],
    },
  },

  // Config files are the one place allowed to read process.env (CLAUDE.md §4).
  {
    files: ['apps/*/src/**/*.ts'],
    ignores: ['apps/*/src/config/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Never read process.env outside src/config/. Add the variable to the Zod schema in env.validation.ts and expose it via a namespaced registerAs factory (CLAUDE.md §4).',
        },
      ],
    },
  },

  { files: ['**/*.spec.ts', '**/*.test.ts', '**/test/**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
);
