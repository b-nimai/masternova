import { HttpException, HttpStatus } from '@nestjs/common';

/** The endpoint requires an `Idempotency-Key` and the client did not send one. */
export class IdempotencyKeyRequiredException extends HttpException {
  constructor() {
    super('This endpoint requires an Idempotency-Key header', HttpStatus.BAD_REQUEST);
  }
}

/**
 * The same key arrived with a different request body.
 *
 * That is a client bug, not a retry, and the two safe responses are both wrong: serving
 * the first response answers a question that was not asked, and processing the new body
 * defeats the key. So it is rejected loudly.
 */
export class IdempotencyKeyReusedException extends HttpException {
  constructor() {
    super(
      'This Idempotency-Key was already used with a different request body',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * A request with this key is still running.
 *
 * Returned rather than queued behind the original: holding the second request open ties
 * up a connection for as long as the first takes, and under a retry storm that is how the
 * pool is exhausted. 409 tells the client to retry shortly.
 */
export class IdempotentRequestInFlightException extends HttpException {
  constructor() {
    super('A request with this Idempotency-Key is still in progress', HttpStatus.CONFLICT);
  }
}
