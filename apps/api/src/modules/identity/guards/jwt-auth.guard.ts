import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { Role } from '@masternova/db';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { TokenService } from '../token.service';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    userRole?: Role;
    sessionId?: string;
  }
}

const COOKIE = 'masternova_access';

/**
 * Authenticates from the access token, and is applied globally — every route is protected
 * unless it says `@Public()`.
 *
 * Verification is a signature check with no database read, which is the point of a JWT
 * here: authorization stays on the hot path without a lookup per request. The cost is that
 * a revoked session keeps working until the token expires; see ADR-0010.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = extractToken(request);
    if (!token) throw new UnauthorizedException('Not authenticated');

    try {
      const claims = this.tokens.verifyAccessToken(token);
      request.userId = claims.sub;
      request.userRole = claims.role;
      request.sessionId = claims.sid;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}

/**
 * Cookie first, `Authorization` header second.
 *
 * The cookie is httpOnly so XSS cannot read it; the header exists for non-browser clients
 * and tests. A browser flow never sends the header, so this is not a CSRF hole — the
 * cookie is SameSite=Strict.
 */
function extractToken(request: FastifyRequest): string | undefined {
  const fromCookie = (request.cookies as Record<string, string> | undefined)?.[COOKIE];
  if (fromCookie) return fromCookie;

  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}
