import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { User } from '@masternova/db';
import type { LoginInput, PublicUser, RegisterInput } from '@masternova/shared';
import { UsersService } from '../users/users.service';

@Injectable()
export class AuthService {
  constructor(private readonly users: UsersService) {}

  async register(input: RegisterInput): Promise<User> {
    const existing = await this.users.findByEmail(input.email);
    if (existing) {
      throw new ConflictException('Email already registered');
    }
    const passwordHash = await argon2.hash(input.password);
    return this.users.create({ email: input.email, passwordHash, name: input.name });
  }

  async validate(input: LoginInput): Promise<User> {
    const user = await this.users.findByEmail(input.email);
    // No password set => OAuth-only account; reject password login.
    if (!user || !user.passwordHash || !(await argon2.verify(user.passwordHash, input.password))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return user;
  }

  /** Google OAuth callback: reuse an existing account by email, else create one. */
  async findOrCreateOAuth(input: { email: string; name?: string }): Promise<User> {
    const existing = await this.users.findByEmail(input.email);
    if (existing) {
      return existing;
    }
    return this.users.create({ email: input.email, name: input.name });
  }

  toPublic(user: User): PublicUser {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerified?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
