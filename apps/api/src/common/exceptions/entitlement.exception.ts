import { ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';

/**
 * 403 with the machine-readable reason attached.
 *
 * **403, not 404.** The rest of this codebase hides other people's rows behind a 404 so an
 * endpoint is not an oracle for probing ids — but a course the learner is looking at is
 * public by construction. Denying it with a 404 would tell an interested buyer that the
 * course does not exist, which is both false and a lost sale. The reason code is what lets
 * the frontend show a buy button for `NO_ENTITLEMENT`, a support link for
 * `ENTITLEMENT_REVOKED`, and a "no longer available" page for `COURSE_NOT_PUBLISHED`,
 * without parsing prose.
 */
export class EntitlementDeniedException extends ForbiddenException {
  constructor(reason: string, subjectId: string) {
    // Under `details`, which is the envelope's existing slot for machine-readable
    // specifics (`AllExceptionsFilter`). Putting them at the top level looked fine in the
    // handler and was silently dropped on the way out — caught by the integration test,
    // which is the only place the filter is in the path.
    super({
      message: 'You do not have access to this content',
      details: { reason, subjectId },
    });
  }
}

/**
 * The playback token is missing, malformed, expired, or bound to someone else.
 *
 * 401 rather than 403: a token is a credential, and the correct client response is to ask
 * the API for a fresh one, which is exactly what 401 means.
 */
export class InvalidPlaybackTokenException extends HttpException {
  constructor(reason: string) {
    super({ message: 'Playback token rejected', details: { reason } }, HttpStatus.UNAUTHORIZED);
  }
}

export class LectureNotFoundException extends HttpException {
  constructor() {
    super('Lecture not found', HttpStatus.NOT_FOUND);
  }
}
