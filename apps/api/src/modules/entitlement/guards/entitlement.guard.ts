import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { Role } from '@masternova/db';
import { EntitlementDeniedException } from '../../../common/exceptions';
import { Verdict } from '../decision';
import type { EntitlementDecision } from '../entitlement-engine';
import { EntitlementService } from '../entitlement.service';
import { ENTITLEMENT_PARAM_KEY, type EntitlementTarget } from './requires-entitlement.decorator';

/**
 * Declared here, next to the only guard that writes it, rather than beside identity's
 * `userId` — that file belongs to another module and must not learn this module's types
 * (CLAUDE.md §4). Declaration merging composes them at the type level without an import.
 */
declare module 'fastify' {
  interface FastifyRequest {
    entitlementDecision?: EntitlementDecision;
  }
}

/**
 * The first of the three enforcement layers: no route marked `@RequiresEntitlement()` runs
 * its handler without an `ALLOW` from the chain.
 *
 * **Why a guard and not a check inside each service.** A check in a service is a check
 * somebody can forget to write, and the failure mode of forgetting is a paid lecture served
 * for free — silently, until someone notices in the access logs. Declared on the route, the
 * absence of the decorator is visible in the same three lines as the route itself.
 *
 * It runs *after* `JwtAuthGuard`, which is what puts `userId` on the request. An
 * unauthenticated request never reaches here.
 */
@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const target = this.reflector.getAllAndOverride<EntitlementTarget>(ENTITLEMENT_PARAM_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!target) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const actor = { id: request.userId as string, role: request.userRole as Role };
    const subjectId = (request.params as Record<string, string>)?.[target.param];

    // A route that declares a parameter it does not have is a wiring bug, and the safe
    // reading of a wiring bug on an authorization path is "deny".
    if (!subjectId) {
      throw new EntitlementDeniedException('MISSING_SUBJECT', target.param);
    }

    const decision =
      target.kind === 'lecture'
        ? await this.entitlements.decideForLecture(subjectId, actor)
        : await this.entitlements.decideForCourse(subjectId, actor);

    if (decision.verdict !== Verdict.Allow) {
      throw new EntitlementDeniedException(decision.reason, subjectId);
    }

    // Handed to the handler so it does not re-run the chain to learn what the guard just
    // decided — the manifest route needs the reason for its audit log.
    request.entitlementDecision = decision;
    return true;
  }
}
