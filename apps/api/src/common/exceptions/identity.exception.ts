import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Deliberately vague. Distinguishing "no such account" from "wrong password" turns the
 * login form into an account-enumeration oracle, which is how credential-stuffing lists
 * get validated cheaply.
 */
export class InvalidCredentialsException extends HttpException {
  constructor() {
    super('Invalid email or password', HttpStatus.UNAUTHORIZED);
  }
}

export class EmailAlreadyRegisteredException extends HttpException {
  constructor() {
    super('Email already registered', HttpStatus.CONFLICT);
  }
}

/** Covers expired, already-used and never-existed, on purpose — see above. */
export class InvalidVerificationTokenException extends HttpException {
  constructor() {
    super('This link is invalid or has expired', HttpStatus.BAD_REQUEST);
  }
}

export class EmailNotVerifiedException extends HttpException {
  constructor() {
    super('Please verify your email address first', HttpStatus.FORBIDDEN);
  }
}
