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
 * Raised by the state machine when the current state does not declare an edge to the
 * requested one — `COURSE_LIFECYCLE` in `catalog/lifecycle/course-lifecycle.ts` is the
 * single place that answers "can this happen next?".
 */
export class IllegalCourseTransitionException extends HttpException {
  constructor(from: string, to: string) {
    super(`A course cannot move from ${from} to ${to}`, HttpStatus.CONFLICT);
  }
}

/**
 * The publish gate said no, and said exactly why.
 *
 * 422 rather than 409: the request was well-formed and the transition is legal from this
 * state — the *content* is not ready. A 409 would say "you are racing someone", which is a
 * different bug and would send a client down the wrong recovery path.
 *
 * The coded problems ride in `details` so the wizard can jump to the offending step without
 * parsing English. See `AllExceptionsFilter`.
 */
export class CourseNotReadyException extends HttpException {
  constructor(problems: readonly { code: string; step: string; message: string }[]) {
    super(
      {
        message: `This course is not ready to publish: ${problems.length} thing(s) still missing`,
        details: { problems },
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

/**
 * Someone else changed this course since the version the caller was holding.
 *
 * The two-open-tabs bug, caught. 409 with both numbers, so the client can say "reload" and
 * a log line can say how far behind it was.
 */
export class CourseVersionConflictException extends HttpException {
  constructor(expected: number, actual: number) {
    super(
      {
        message: 'This course was changed elsewhere. Reload and try again.',
        details: { expectedVersion: expected, currentVersion: actual },
      },
      HttpStatus.CONFLICT,
    );
  }
}

/** Only a reviewer approves a course out of IN_REVIEW — see `COURSE_LIFECYCLE`. */
export class ReviewerRoleRequiredException extends HttpException {
  constructor() {
    super('Only a reviewer can publish a course out of review', HttpStatus.FORBIDDEN);
  }
}

/** The undo stack is empty — every edit on this course has already been undone. */
export class NothingToUndoException extends HttpException {
  constructor() {
    super('There is nothing left to undo on this course', HttpStatus.CONFLICT);
  }
}

/**
 * A section or lecture id that is not in this course.
 *
 * One exception for both, and deliberately not "section not found": the id may well exist,
 * just under someone else's course, and saying which of the two it is turns the endpoint
 * into an oracle for enumerating other instructors' curricula.
 */
export class CurriculumNodeNotFoundException extends HttpException {
  constructor() {
    super('No such section or lecture in this course', HttpStatus.NOT_FOUND);
  }
}

/**
 * A reorder that is not a permutation of what is there.
 *
 * Rejected rather than best-effort applied: a reorder missing an id would silently leave
 * that row wherever it was, which looks like the drag "didn't take" and is impossible to
 * report a bug about.
 */
export class InvalidReorderException extends HttpException {
  constructor() {
    super(
      'A reorder must list exactly the items being reordered, once each',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * An archived course cannot be edited.
 *
 * 409 rather than 403: the caller is allowed to touch this course, it is the course's state
 * that forbids the operation — and that distinction is what tells a client whether to hide
 * the button or show "this course is archived".
 */
export class CourseIsArchivedException extends HttpException {
  constructor() {
    super('An archived course cannot be edited', HttpStatus.CONFLICT);
  }
}
