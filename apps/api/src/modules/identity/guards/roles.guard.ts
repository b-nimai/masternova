import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { Role } from '@masternova/db';
import { ROLES_KEY } from '../../../common/decorators/roles.decorator';

/**
 * Coarse role check, running after {@link JwtAuthGuard} has populated the request.
 *
 * This answers "what kind of user is this", and deliberately nothing more. "May this user
 * play this lecture" depends on purchases, refund windows and publish state, and belongs
 * to the entitlement engine (task 1.8) — trying to express it as roles is how you end up
 * with a `PURCHASER_OF_COURSE_123` role.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!request.userRole || !required.includes(request.userRole)) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
