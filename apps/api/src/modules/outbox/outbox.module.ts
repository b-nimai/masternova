import { Global, Module } from '@nestjs/common';
import { UNIT_OF_WORK } from '@masternova/contracts';
import { PrismaUnitOfWork } from '@masternova/db';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The write half of the transactional outbox. The read half — claiming, dispatching and
 * retrying — is `apps/worker/src/modules/outbox-relay`, because it has a completely
 * different lifecycle: this side runs inside a request, that side runs on a poll loop.
 *
 * Global on purpose. Every bounded context writes through the Unit of Work, and making
 * each one import this module would be ceremony without a decision behind it. Consumers
 * inject the `UNIT_OF_WORK` token from `@masternova/contracts` and never see this class,
 * so the seam survives: swapping the implementation touches this file only.
 */
@Global()
@Module({
  providers: [
    {
      // `useFactory`, not `useClass`: the implementation now lives in `packages/db` and
      // takes a plain `PrismaClient`, so it has no Nest decorators for the container to
      // read constructor metadata from. The app supplies its own client.
      provide: UNIT_OF_WORK,
      useFactory: (prisma: PrismaService) => new PrismaUnitOfWork(prisma),
      inject: [PrismaService],
    },
  ],
  exports: [UNIT_OF_WORK],
})
export class OutboxModule {}
