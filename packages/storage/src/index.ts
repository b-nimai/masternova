/**
 * Object storage, as a port plus one S3/MinIO adapter.
 *
 * Both deployables need it: the API hands out presigned upload URLs (task 1.6) and the
 * worker reads the source object and writes renditions (task 1.7). It is a package rather
 * than a module inside either app for the same reason `packages/db` is — an app importing
 * another app's internals is the boundary violation CLAUDE.md §4 forbids, one level up.
 *
 * What belongs here: the port, its adapter, and the config shape they need. What does not:
 * anything that knows what a *lecture* is. This package moves bytes.
 */
export * from './storage.interface.js';
export * from './storage.config.js';
export * from './storage.exception.js';
export * from './storage.service.js';
export * from './storage.module.js';
