import { Inject, Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import {
  USER_REPOSITORY,
  type CreateUserData,
  type IUserRepository,
} from './repositories/user.repository.interface';

@Injectable()
export class UsersService {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
  ) {}

  create(data: CreateUserData): Promise<User> {
    return this.users.create(data);
  }

  findByEmail(email: string): Promise<User | null> {
    return this.users.findByEmail(email);
  }

  findById(id: string): Promise<User | null> {
    return this.users.findById(id);
  }
}
