import type { User } from '@masternova/db';

/** Injection token for the user repository abstraction (CLAUDE.md §1 D). */
export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

export interface CreateUserData {
  email: string;
  passwordHash?: string;
  name?: string;
}

/**
 * Persistence contract for {@link User}. Services depend on this, never on Prisma, so a
 * service test uses a fake instead of a database — if a service test needs Prisma, D was
 * violated and the design is what should change (CLAUDE.md §6).
 *
 * `executor` is the optional transaction handle from the Unit of Work. Passing it makes
 * the write join the caller's transaction; omitting it uses the default connection.
 */
export interface IUserRepository {
  create(data: CreateUserData, executor?: unknown): Promise<User>;
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  markEmailVerified(userId: string, executor?: unknown): Promise<void>;
  updatePasswordHash(userId: string, passwordHash: string, executor?: unknown): Promise<void>;
}
