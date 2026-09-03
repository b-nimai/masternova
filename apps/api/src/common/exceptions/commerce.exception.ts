import { BadRequestException, ConflictException, HttpException, HttpStatus } from '@nestjs/common';

/**
 * The webhook body did not verify.
 *
 * **400, deliberately not 401 or 500.** Payment providers retry any non-2xx, and they back
 * off on 5xx while treating 4xx as "stop, this will never work". A signature that does not
 * check out will not check out on the tenth attempt either, so a 5xx here would have the
 * provider hammering the endpoint for days over a misconfigured secret.
 */
export class WebhookSignatureException extends HttpException {
  constructor(detail: string) {
    super(
      { message: 'Webhook signature rejected', details: { reason: detail } },
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * The provider itself failed or timed out.
 *
 * 502, because the failure is upstream and the client's request was fine. It also tells our
 * own retry logic apart from a client error in the logs.
 */
export class PaymentProviderException extends HttpException {
  constructor(detail: string) {
    super(
      { message: 'Payment provider unavailable', details: { reason: detail } },
      HttpStatus.BAD_GATEWAY,
    );
  }
}

export class CartEmptyException extends BadRequestException {
  constructor() {
    super('Your cart is empty');
  }
}

/** Buying something twice is the mistake this prevents, not an edge case. */
export class AlreadyOwnedException extends ConflictException {
  constructor(courseIds: readonly string[]) {
    super({
      message: 'You already own one or more of these courses',
      details: { reason: 'ALREADY_OWNED', courseIds },
    });
  }
}

export class CourseNotPurchasableException extends BadRequestException {
  constructor(courseId: string, reason: string) {
    super({ message: 'This course cannot be purchased', details: { reason, courseId } });
  }
}

/** One currency per order. Converting at checkout is not a thing this platform will do. */
export class MixedCurrencyCartException extends BadRequestException {
  constructor(currencies: readonly string[]) {
    super({
      message: 'A cart cannot mix currencies',
      details: { reason: 'MIXED_CURRENCY', currencies },
    });
  }
}

export class CouponRejectedException extends BadRequestException {
  constructor(reason: string, code: string) {
    super({ message: 'This coupon cannot be applied', details: { reason, code } });
  }
}

export class OrderNotFoundException extends HttpException {
  constructor() {
    super('Order not found', HttpStatus.NOT_FOUND);
  }
}

/**
 * The transition does not exist from where the order is.
 *
 * 409, not 400: the request was well-formed and would have been legal a moment ago. That is
 * what a conflict is, and it tells a client to re-read the order rather than fix its JSON.
 */
export class IllegalOrderTransitionException extends ConflictException {
  constructor(from: string, name: string) {
    super({
      message: `An order in ${from} cannot be ${name}ed`,
      details: { reason: 'ILLEGAL_TRANSITION', from, transition: name },
    });
  }
}
