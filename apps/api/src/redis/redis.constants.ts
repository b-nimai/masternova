/** The shared ioredis connection. A `Symbol`, like every other injected dependency (CLAUDE.md §1 D). */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
