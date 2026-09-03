import {
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DeadLetteredJob, PipelineProgress } from '@masternova/shared';
import { Roles } from '../../common/decorators/roles.decorator';
import { actorOf } from '../catalog/actor.request';
import { PipelineStatusService } from './pipeline-status.service';

/**
 * The wizard's view of the transcode pipeline, and the operator's.
 *
 * Both live here rather than in a separate admin module because they read the same two
 * sources and would otherwise duplicate the Redis connection and the ownership rule.
 */
@Roles('INSTRUCTOR', 'ADMIN')
@Controller('media/assets/:id/pipeline')
export class PipelineController {
  constructor(private readonly pipeline: PipelineStatusService) {}

  /** One-shot progress, for a client that would rather poll than hold a connection open. */
  @Get()
  progress(@Param('id') id: string, @Req() request: FastifyRequest): Promise<PipelineProgress> {
    return this.pipeline.progressFor(id, actorOf(request));
  }

  /**
   * Server-Sent Events, not a WebSocket.
   *
   * The data flows one way and the client only ever watches — SSE gets that with a plain
   * HTTP response, automatic browser reconnection, and no second protocol to secure,
   * proxy or scale. A WebSocket would buy bidirectionality nothing here needs, and cost a
   * sticky-session requirement in front of the load balancer (task 2.6).
   *
   * `@Res()` because Nest's own `@Sse()` decorator wraps an RxJS Observable and this is an
   * async generator over a repository — driving the reply directly is less machinery than
   * bridging the two, and it keeps the disconnect handling visible.
   */
  @Get('stream')
  async stream(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Nginx and ALB both buffer by default, which holds every event until the response
      // ends — turning a live progress bar into one frame at the very end.
      'X-Accel-Buffering': 'no',
    });

    // The client closing the tab is the *normal* way this ends, not an error. The signal
    // goes *into* the generator rather than being checked after each yield, because the
    // generator only yields when the progress changes — a bar sitting at 40% would keep
    // polling Postgres for a reader that has gone until it happened to move.
    const disconnected = new AbortController();
    let open = true;
    request.raw.on('close', () => {
      open = false;
      disconnected.abort();
    });

    try {
      for await (const progress of this.pipeline.stream(
        id,
        actorOf(request),
        disconnected.signal,
      )) {
        if (!open) break;
        reply.raw.write(`data: ${JSON.stringify(progress)}\n\n`);
      }
    } finally {
      if (open) reply.raw.end();
    }
  }
}

/**
 * The dead-letter queue. Admin only — a replay re-runs work against someone's asset, and
 * an instructor has no business reaching into the queue to do that.
 */
@Roles('ADMIN')
@Controller('admin/pipeline/dead-letter')
export class PipelineDeadLetterController {
  constructor(private readonly pipeline: PipelineStatusService) {}

  @Get()
  list(): Promise<DeadLetteredJob[]> {
    return this.pipeline.deadLettered();
  }

  /**
   * No `@Idempotent()`. `retry()` moves an existing job back to waiting, so replaying the
   * same id twice leaves it queued once — the operation is already idempotent in the queue,
   * and a stored response would only hide that from the operator.
   */
  @Post(':jobId/replay')
  @HttpCode(202)
  async replay(@Param('jobId') jobId: string): Promise<{ replayed: true }> {
    const replayed = await this.pipeline.replay(jobId);
    if (!replayed) throw new NotFoundException('No such dead-lettered job');
    return { replayed: true };
  }
}
