import type { User } from '@masternova/db';

/** Injection token for the user repository abstraction. */
export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

export interface CreateUserData {
  email: string;
  passwordHash?: string;
  name?: string;
}

/** Persistence contract for {@link User}; hides the concrete ORM from services (DIP). */
export interface IUserRepository {
  create(data: CreateUserData): Promise<User>;
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
}
