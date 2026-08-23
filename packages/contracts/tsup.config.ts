import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,

  /*
   * Never clean in watch mode.
   *
   * `pnpm dev` runs this watcher and the apps' `nest --watch` in parallel. `clean: true`
   * empties dist/ at the start of every rebuild, and the .d.ts is emitted last — so there
   * is a reliable window in which an app's tsc resolves `main` (index.cjs) and finds no
   * types, fails with TS7016 "implicitly has an 'any' type", and caches that failure.
   * The symptom is an API container that will not boot after an unrelated edit.
   *
   * A one-shot build still cleans, because that is where a stale artefact would actually
   * matter. In watch mode every file is overwritten in place instead.
   */
  clean: !options.watch,
}));
