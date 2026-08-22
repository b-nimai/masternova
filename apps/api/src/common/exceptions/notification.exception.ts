import { HttpException, HttpStatus } from '@nestjs/common';

/** Covers tampered, truncated, wrong-secret and unknown-version, on purpose. */
export class InvalidUnsubscribeTokenException extends HttpException {
  constructor() {
    super('This unsubscribe link is invalid', HttpStatus.BAD_REQUEST);
  }
}

/**
 * The webhook signature did not verify, or no secret is configured.
 *
 * 401 rather than 400: providers treat 4xx as "stop retrying", and that is the correct
 * outcome for a caller who cannot prove who they are. An unconfigured secret failing
 * closed is deliberate — unverified is not the same as unconfigured.
 */
export class InvalidWebhookSignatureException extends HttpException {
  constructor() {
    super('Invalid webhook signature', HttpStatus.UNAUTHORIZED);
  }
}
