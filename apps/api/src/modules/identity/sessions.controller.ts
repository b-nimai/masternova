import { Controller, Delete, Get, HttpCode, Param, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { SessionService } from './session.service';

/**
 * "Your devices" — list active sessions and sign one out.
 *
 * Separate from AuthController because it changes for a different reason: this is account
 * management, that is the credential lifecycle (CLAUDE.md §1 S).
 */
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionService) {}

  @Get()
  list(@Req() req: FastifyRequest) {
    return this.sessions.listActive(req.userId as string);
  }

  /** Scoped to the caller inside the service, so a guessed id cannot revoke someone else's. */
  @Delete(':id')
  @HttpCode(204)
  async revoke(@Req() req: FastifyRequest, @Param('id') id: string): Promise<void> {
    await this.sessions.revokeOwn(req.userId as string, id);
  }
}
