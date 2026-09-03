import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,

  /**
   * This package **must** be built, unlike `packages/db`.
   *
   * Node 24 loads a `.ts` source by *type stripping*, which erases annotations but does not
   * transform or resolve anything — so a relative specifier in a shipped `.ts` file cannot
   * find its sibling (`ERR_MODULE_NOT_FOUND`), and `.js` does not map back to `.ts` either.
   * `packages/db` sidesteps that by having no relative imports; this package has five files
   * that genuinely reference each other, so it emits real JavaScript instead.
   *
   * Found by running the stack. Both apps typechecked and every test passed.
   */
  clean: !options.watch,

  /**
   * `StorageService` is a Nest provider, so its decorators must survive the build. esbuild
   * implements the legacy decorator semantics `experimentalDecorators` selects, which is
   * what Nest expects. Design-time metadata is deliberately *not* relied on: the one
   * injected dependency is bound with an explicit `@Inject(STORAGE_CONFIG)` token rather
   * than by parameter type, so nothing here needs `emitDecoratorMetadata`.
   */
  tsconfig: 'tsconfig.json',
}));
