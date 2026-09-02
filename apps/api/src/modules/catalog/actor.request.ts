import type { FastifyRequest } from 'fastify';
import type { Role } from '@masternova/db';
import type { Actor } from './actor';

/**
 * The one place the authenticated request is turned into an `Actor`.
 *
 * Kept out of `actor.ts` so the domain type stays free of Fastify: the command handlers and
 * the state machine take an `Actor` and must remain testable without inventing a request.
 */
export function actorOf(request: FastifyRequest): Actor {
  return { id: request.userId as string, role: request.userRole as Role };
}
