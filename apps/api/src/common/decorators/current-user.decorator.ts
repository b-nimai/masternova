import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/** Resolves the authenticated user id set by {@link AuthenticatedGuard}. */
export const CurrentUserId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest & { userId?: string }>();
  return req.userId as string;
});
