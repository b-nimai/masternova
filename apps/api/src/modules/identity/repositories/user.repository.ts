import { Injectable } from '@nestjs/common';
import type { PrismaClient, User } from '@masternova/db';
import { PrismaService } from '../../../prisma/prisma.service';
import type { CreateUserData, IUserRepository } from './user.repository.interface';

@Injectable()
export class PrismaUserRepository implements IUserRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Uses the caller's transaction when given one, so writes stay atomic with their events. */
  private client(executor?: unknown): PrismaClient {
    return (executor as PrismaClient) ?? this.prisma;
  }

  create(data: CreateUserData, executor?: unknown): Promise<User> {
    return this.client(executor).user.create({ data });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async markEmailVerified(userId: string, executor?: unknown): Promise<void> {
    await this.client(executor).user.update({
      where: { id: userId },
      data: { emailVerified: new Date() },
    });
  }

  async updatePasswordHash(
    userId: string,
    passwordHash: string,
    executor?: unknown,
  ): Promise<void> {
    await this.client(executor).user.update({ where: { id: userId }, data: { passwordHash } });
  }
}
