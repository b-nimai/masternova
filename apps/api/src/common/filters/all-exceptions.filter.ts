import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

interface ErrorEnvelope {
  statusCode: number;
  error: string;
  message: unknown;
  /**
   * Machine-readable specifics, when an error has any. Present only if the exception put
   * them there.
   *
   * The force: the publish gate rejects with a *list* of coded problems, and flattening
   * that into one English sentence makes the client parse prose to know which wizard step
   * to open. `message` stays the human sentence; `details` carries the codes.
   */
  details?: unknown;
  timestamp: string;
  path: string;
}

/**
 * Catches every unhandled error and returns a consistent JSON envelope. HttpExceptions
 * keep their status and body; anything else becomes a 500 (details logged, not leaked).
 * Fastify-aware: writes through FastifyReply.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = isHttp ? exception.getResponse() : undefined;

    if (!isHttp) {
      this.logger.error(
        'Unhandled exception',
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const envelope: ErrorEnvelope = {
      statusCode: status,
      error: HttpStatus[status] ?? 'ERROR',
      // HttpException bodies are typically { statusCode, message, error }; forward the
      // message when present, otherwise the whole body / a generic fallback.
      message:
        typeof body === 'object' && body !== null && 'message' in body
          ? (body as { message: unknown }).message
          : (body ?? 'Internal server error'),
      timestamp: new Date().toISOString(),
      path: request.url,
      ...(typeof body === 'object' && body !== null && 'details' in body
        ? { details: (body as { details: unknown }).details }
        : {}),
    };

    void reply.status(status).send(envelope);
  }
}
