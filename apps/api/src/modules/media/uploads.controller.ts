import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  createUploadSchema,
  type AssetView,
  type CreateUploadInput,
  type UploadSessionView,
} from '@masternova/shared';
import { ZodBody } from '../../common/pipes/zod-body.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { actorOf } from '../catalog/actor.request';
import { UploadSessionService } from './upload-session.service';
import { UploadCompletionService } from './upload-completion.service';

/**
 * The four calls a resumable upload needs, and nothing else.
 *
 * Note what is missing: an endpoint that receives file bytes. Every byte goes from the
 * browser straight to object storage on a presigned URL, so a 10 GB lecture never occupies
 * an API process, never counts against a body-size limit and never makes a request time
 * out. The API's job here is to hand out credentials and to be the authority on what the
 * upload *means*.
 */
@Roles('INSTRUCTOR', 'ADMIN')
@Controller('media/uploads')
export class UploadsController {
  constructor(
    private readonly sessions: UploadSessionService,
    private readonly completion: UploadCompletionService,
  ) {}

  /**
   * No `@Idempotent()`. A retried create makes a second session against a second key and
   * costs one abandoned multipart upload that the reaper collects — whereas storing a
   * replay response would hand the client presigned URLs that had already begun expiring.
   */
  @Post()
  create(
    @ZodBody(createUploadSchema) body: CreateUploadInput,
    @Req() request: FastifyRequest,
  ): Promise<UploadSessionView> {
    return this.sessions.create(body, actorOf(request));
  }

  /**
   * Progress and resume are the same call, deliberately.
   *
   * A separate `/resume` would be a second code path taken only after a crash — which is
   * to say, the path that is never exercised until the day it matters. Folding it into the
   * status poll means every upload runs the recovery logic on every window.
   */
  @Get(':id')
  get(@Param('id') id: string, @Req() request: FastifyRequest): Promise<UploadSessionView> {
    return this.sessions.resume(id, actorOf(request));
  }

  /**
   * `@Idempotent()` because a completion that times out on the client is exactly the
   * request they will retry, and the second attempt would otherwise get a 409 for work
   * that had already succeeded — sending the wizard down a failure path after a success.
   */
  @Post(':id/complete')
  @Idempotent()
  @HttpCode(200)
  complete(
    @Param('id') id: string,
    @Body() _body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<AssetView> {
    return this.completion.complete(id, actorOf(request));
  }

  @Delete(':id')
  @HttpCode(204)
  async abort(@Param('id') id: string, @Req() request: FastifyRequest): Promise<void> {
    await this.completion.abort(id, actorOf(request));
  }
}
