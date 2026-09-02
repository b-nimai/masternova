import { createHash } from 'node:crypto';
import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { Observable, from, of, switchMap, tap, catchError, throwError } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';
import { IDEMPOTENT_KEY } from '../decorators/idempotent.decorator';
import {
  IdempotencyKeyRequiredException,
  IdempotencyKeyReusedException,
  IdempotentRequestInFlightException,
} from '../exceptions';

const HEADER = 'idempotency-key';
const RETENTION_HOURS = 24;
/** Prisma's unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

/**
 * Replay protection for handlers marked `@Idempotent()`.
 *
 * A client that never learns the outcome of a request — timeout, dropped connection,
 * backgrounded phone — will retry. Without this, the retry charges the card a second
 * time. With it, the retry gets the first response back.
 *
 * The record is claimed IN_FLIGHT before the handler runs, using the unique constraint on
 * (scope, key) as the lock. Checking-then-inserting would leave a window in which two
 * concurrent retries both see "no record" and both charge; letting the database arbitrate
 * closes it, because exactly one INSERT can win.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const required = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return next.handle();

    const request = context.switchToHttp().getRequest<FastifyRequest & { userId?: string }>();
    const key = request.headers[HEADER];

    if (typeof key !== 'string' || key.trim().length === 0) {
      return throwError(() => new IdempotencyKeyRequiredException());
    }

    const scope = request.userId ?? `anon:${hash(request.ip ?? 'unknown')}`;
    // The route *pattern* (`/instructor/courses/:id/duplicate`), for a readable log.
    const endpoint = `${request.method} ${request.routeOptions?.url ?? request.url}`;

    /**
     * The hash covers **the target as well as the body**, and the target has to be the
     * concrete path rather than the pattern.
     *
     * Several idempotent routes here identify their resource purely by a path param and
     * send no body at all — `POST /courses/:id/duplicate`, `POST /courses/:id/curriculum/undo`.
     * Hashing the body alone makes every one of them hash `"null"`, so one key reused across
     * two courses would hand back the *first* course's stored response and never touch the
     * second. A client that mints one key per page load rather than per click hits that
     * immediately, and it fails silently with a 200.
     */
    const requestHash = hash(
      JSON.stringify({
        target: `${request.method} ${request.url}`,
        body: request.body ?? null,
      }),
    );

    return from(this.claim({ scope, key, endpoint, requestHash })).pipe(
      switchMap((replay) =>
        replay ? of(replay.body) : this.runAndStore(context, next, scope, key),
      ),
    );
  }

  /**
   * Claims the key, or resolves to the stored response if this is a replay.
   *
   * Returns `{ body }` for a replay so that a legitimately-null stored response is not
   * confused with "no replay".
   */
  private async claim(input: {
    scope: string;
    key: string;
    endpoint: string;
    requestHash: string;
  }): Promise<{ body: unknown } | null> {
    try {
      await this.prisma.idempotencyRecord.create({
        data: {
          scope: input.scope,
          key: input.key,
          endpoint: input.endpoint,
          requestHash: input.requestHash,
          expiresAt: new Date(Date.now() + RETENTION_HOURS * 3_600_000),
        },
      });
      return null;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: { scope_key: { scope: input.scope, key: input.key } },
    });

    // Expired and swept between the failed insert and this read: treat as a fresh key.
    if (!existing) return null;

    if (existing.requestHash !== input.requestHash) {
      throw new IdempotencyKeyReusedException();
    }
    if (existing.status === 'IN_FLIGHT') {
      throw new IdempotentRequestInFlightException();
    }

    this.logger.log(`replaying stored response for ${input.endpoint} key=${input.key}`);
    return { body: existing.response };
  }

  private runAndStore(
    context: ExecutionContext,
    next: CallHandler,
    scope: string,
    key: string,
  ): Observable<unknown> {
    const reply = context.switchToHttp().getResponse<FastifyReply>();

    return next.handle().pipe(
      tap((body) => {
        // Fire-and-forget: the caller already has their answer, and failing to persist
        // the record must not fail a request that genuinely succeeded. The cost is that
        // a crash here turns the next retry into a real second execution — which is why
        // handlers behind this must still be idempotent in their own right.
        void this.prisma.idempotencyRecord
          .update({
            where: { scope_key: { scope, key } },
            data: {
              status: 'COMPLETED',
              statusCode: reply.statusCode,
              response: (body ?? null) as object,
            },
          })
          .catch((error: unknown) => {
            this.logger.error(`failed to store idempotent response for key=${key}`, error);
          });
      }),
      catchError((error: unknown) => {
        // A failed request must not be replayable — the client should be able to retry
        // and actually get through. Releasing the claim is what makes that possible.
        void this.prisma.idempotencyRecord
          .delete({ where: { scope_key: { scope, key } } })
          .catch(() => undefined);
        return throwError(() => error);
      }),
    );
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}
