import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  curriculumEditRequestSchema,
  type Curriculum,
  type CurriculumEditRequest,
} from '@masternova/shared';
import { ZodBody } from '../../../common/pipes/zod-body.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { Idempotent } from '../../../common/decorators/idempotent.decorator';
import { actorOf } from '../actor.request';
import { CurriculumService } from './curriculum.service';

/**
 * One route for every kind of curriculum edit, because the edit is a Command.
 *
 * The obvious alternative — `POST /sections`, `PATCH /sections/:id`, `DELETE /lectures/:id`
 * and six more — was rejected for one reason: it cannot be undone. A `DELETE` leaves nothing
 * to reverse, so undo would need a parallel history mechanism that the REST surface knows
 * nothing about. Sending the edit as a value means the same object that was applied is the
 * one that gets stored, inverted and replayed.
 */
@Roles('INSTRUCTOR', 'ADMIN')
@Controller('instructor/courses/:id/curriculum')
export class CurriculumController {
  constructor(private readonly curriculum: CurriculumService) {}

  @Get()
  get(@Param('id') id: string, @Req() request: FastifyRequest): Promise<Curriculum> {
    return this.curriculum.get(id, actorOf(request));
  }

  /**
   * No `@Idempotent()`, and that is deliberate: `expectedVersion` already makes a replay
   * safe. The retry carries the version the client last saw, the first attempt consumed it,
   * and the second gets a 409 — which is a *better* answer than a stored response, because
   * the client's copy really is stale by then.
   */
  @Post()
  @HttpCode(200)
  apply(
    @Param('id') id: string,
    @ZodBody(curriculumEditRequestSchema) body: CurriculumEditRequest,
    @Req() request: FastifyRequest,
  ): Promise<Curriculum> {
    return this.curriculum.apply(id, body, actorOf(request));
  }

  /**
   * `@Idempotent()` here, though — undo has no version to guard it, so a double-tap or a
   * retried request would pop two edits off the stack instead of one, and the second one is
   * work the instructor never asked to lose.
   */
  @Post('undo')
  @Idempotent()
  @HttpCode(200)
  undo(
    @Param('id') id: string,
    @Body() _body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<Curriculum> {
    return this.curriculum.undo(id, actorOf(request));
  }
}
