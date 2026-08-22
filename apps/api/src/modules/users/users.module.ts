import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { USER_REPOSITORY } from './repositories/user.repository.interface';
import { PrismaUserRepository } from './repositories/user.repository';

@Module({
  providers: [UsersService, { provide: USER_REPOSITORY, useClass: PrismaUserRepository }],
  exports: [UsersService],
})
export class UsersModule {}
