import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { StorageService } from './storage.service';
import { STORAGE_PROVIDER } from './storage.interface';
import { STORAGE_CONFIG, type StorageConfig } from './storage.config';

export interface StorageModuleAsyncOptions {
  imports?: DynamicModule['imports'];
  inject?: Provider extends never ? never : unknown[];
  useFactory: (...args: never[]) => StorageConfig | Promise<StorageConfig>;
}

/**
 * Mounted with `StorageModule.forRootAsync({ inject, useFactory })`, or `forRoot(config)`
 * where the config is already a value.
 *
 * Dynamic rather than static because the package must not read `process.env` — each app
 * reads its own environment in its own `src/config/` (CLAUDE.md §4) and passes the result
 * in. That is also what lets a test mount it against a Testcontainers MinIO without
 * mutating globals.
 *
 * **`forRootAsync` is the one the apps use, and the reason is a bug this caused.** The
 * eager form evaluates its argument when the module file is *imported*, which is before a
 * test's `beforeAll` has pointed `S3_ENDPOINT` at its container — so every upload test
 * started signing URLs for the wrong host. Resolving through a factory defers it to DI
 * time, which is where `@nestjs/config` has already loaded the environment.
 *
 * The service is bound to `STORAGE_PROVIDER`, never exported by class: callers depend on
 * the port (§1 D), so a caching or retrying Decorator can be slipped in later without any
 * of them changing.
 */
@Module({})
export class StorageModule {
  static forRoot(config: StorageConfig): DynamicModule {
    return StorageModule.build([{ provide: STORAGE_CONFIG, useValue: config }]);
  }

  static forRootAsync(options: StorageModuleAsyncOptions): DynamicModule {
    return StorageModule.build(
      [
        {
          provide: STORAGE_CONFIG,
          useFactory: options.useFactory,
          inject: (options.inject ?? []) as never[],
        },
      ],
      options.imports,
    );
  }

  private static build(
    configProviders: Provider[],
    imports?: DynamicModule['imports'],
  ): DynamicModule {
    return {
      module: StorageModule,
      imports,
      providers: [...configProviders, { provide: STORAGE_PROVIDER, useClass: StorageService }],
      exports: [STORAGE_PROVIDER],
    };
  }
}
