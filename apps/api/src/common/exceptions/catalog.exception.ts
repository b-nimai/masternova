import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Also the answer for a course the viewer may not see.
 *
 * A 403 on an unpublished course confirms that it exists, which is an information leak
 * dressed up as correctness. Visibility is part of the query, so "not visible to you" and
 * "does not exist" are genuinely the same answer here.
 */
export class CourseNotFoundException extends HttpException {
  constructor() {
    super('Course not found', HttpStatus.NOT_FOUND);
  }
}

/** Used where the caller already proved the course exists — an instructor's own dashboard. */
export class NotCourseOwnerException extends HttpException {
  constructor() {
    super('This course belongs to another instructor', HttpStatus.FORBIDDEN);
  }
}

export class InvalidPriceRangeException extends HttpException {
  constructor() {
    super('The minimum price cannot be above the maximum', HttpStatus.BAD_REQUEST);
  }
}

/** A cursor that was hand-edited, truncated, or issued for a different sort order. */
export class InvalidCursorException extends HttpException {
  constructor() {
    super('Invalid pagination cursor', HttpStatus.BAD_REQUEST);
  }
}

/**
 * The trivial guard task 1.4 ships. Task 1.5 replaces it with the full state machine —
 * the exception stays, only the rule that raises it gets richer.
 */
export class IllegalCourseTransitionException extends HttpException {
  constructor(from: string, to: string) {
    super(`A course cannot move from ${from} to ${to}`, HttpStatus.CONFLICT);
  }
}
