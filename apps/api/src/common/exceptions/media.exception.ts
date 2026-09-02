import { HttpException, HttpStatus } from '@nestjs/common';

/** Also the answer for someone else's upload — see `CourseNotFoundException` for why. */
export class UploadSessionNotFoundException extends HttpException {
  constructor() {
    super('Upload session not found', HttpStatus.NOT_FOUND);
  }
}

export class AssetNotFoundException extends HttpException {
  constructor() {
    super('Asset not found', HttpStatus.NOT_FOUND);
  }
}

/**
 * 415, not 400: the request is well-formed and the field is valid — the *media type* is
 * the thing being refused, which is exactly what 415 means, and it tells a client to stop
 * retrying rather than to fix its JSON.
 */
export class UnsupportedMediaKindException extends HttpException {
  constructor(kind: string, contentType: string, accepted: readonly string[]) {
    super(
      {
        message: `A ${kind} asset cannot be ${contentType}`,
        details: { contentType, accepted },
      },
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    );
  }
}

/**
 * 413 with the cap in `details`, so the client can say "max 10 GB" rather than "too big".
 */
export class UploadTooLargeException extends HttpException {
  constructor(sizeBytes: bigint, maxBytes: bigint) {
    super(
      {
        message: 'This file is larger than the limit for its type',
        details: { sizeBytes: sizeBytes.toString(), maxBytes: maxBytes.toString() },
      },
      HttpStatus.PAYLOAD_TOO_LARGE,
    );
  }
}

/**
 * The session's current state does not declare this edge —
 * `UPLOAD_SESSION_LIFECYCLE` is the single place that answers "can this happen next?".
 *
 * 409 because the caller is allowed to touch this session; it is the session's state that
 * refuses. Completing an already-completed upload lands here, and the client's correct
 * response is to read the session, not to retry.
 */
export class IllegalUploadTransitionException extends HttpException {
  constructor(from: string, event: string) {
    super(`An upload in ${from} cannot be ${event}ed`, HttpStatus.CONFLICT);
  }
}

/**
 * Another request is assembling this upload right now.
 *
 * 409 and — critically — *no state change*. The earlier version of this path treated any
 * COMPLETING session as one to recover, which meant a concurrent retry released the claim
 * of the request that was actively assembling, and the winner then found its own session
 * moved out from under it. A caller that is merely late must look and leave.
 */
export class UploadInProgressException extends HttpException {
  constructor() {
    super('This upload is already being finalised', HttpStatus.CONFLICT);
  }
}

/**
 * The provider is not holding every part the plan called for.
 *
 * 409 with the missing numbers in `details`, because this is a *resumable* upload: the
 * client's correct move is to re-request URLs for exactly these parts and send them, and
 * telling it which ones turns a dead end into the resume path.
 */
export class UploadIncompleteException extends HttpException {
  constructor(missing: readonly number[], expected: number) {
    super(
      {
        message: `${missing.length} of ${expected} parts have not been uploaded`,
        details: { missingParts: missing.slice(0, 100), expectedParts: expected },
      },
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * The bytes the provider is holding do not add up to the size the client declared.
 *
 * This is the check that makes the per-kind size caps mean anything. A presigned
 * `UploadPart` URL binds no content length, so without it a client could declare one byte
 * and PUT five gigabytes to the single part that declaration produced — bypassing the cap
 * and then announcing a one-byte asset to a transcode pipeline about to open a 5 GB file.
 */
export class UploadSizeMismatchException extends HttpException {
  constructor(declared: bigint, actual: bigint) {
    super(
      {
        message: 'The uploaded bytes do not match the size this upload was created for',
        details: { declaredBytes: declared.toString(), uploadedBytes: actual.toString() },
      },
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * A part exists but is under the provider's 5 MiB floor while not being the last part.
 *
 * Caught here rather than at the provider, because S3 reports `EntityTooSmall` only at
 * complete time and does not say which part — by which point the multipart upload is
 * unusable and the instructor has waited for the whole transfer to find out.
 */
export class MalformedUploadPartException extends HttpException {
  constructor(partNumber: number) {
    super(
      {
        message: `Part ${partNumber} is smaller than the minimum part size`,
        details: { partNumber },
      },
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * The session outlived its expiry but the reaper has not reached it yet.
 *
 * 410 rather than 404: the session genuinely existed and the client may well be holding a
 * valid id from an hour ago. "Gone" tells it to start a new upload; "not found" would look
 * like a bug in its own bookkeeping.
 */
export class UploadSessionExpiredException extends HttpException {
  constructor() {
    super('This upload session has expired. Start a new upload.', HttpStatus.GONE);
  }
}
