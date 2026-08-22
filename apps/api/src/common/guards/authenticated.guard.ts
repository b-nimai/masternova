import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * Allows the request only if a session exists, and attaches `userId` to the request
 * (read by {@link CurrentUserId}). Sessions live in the encrypted
 * @fastify/secure-session cookie.
 */
@Injectable()
export class AuthenticatedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const userId = req.session?.get('userId') as string | undefined;
    if (!userId) {
      throw new UnauthorizedException('Not authenticated');
    }
    (req as FastifyRequest & { userId?: string }).userId = userId;
    return true;
  }
}
