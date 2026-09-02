import { Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { InstructorCourse, PublishReadiness } from '@masternova/shared';
import { Roles } from '../../../common/decorators/roles.decorator';
import { actorOf } from '../actor.request';
import { toInstructorCourse } from '../course.mapper';
import { CourseLifecycleService } from './course-lifecycle.service';

/**
 * The lifecycle verbs, on their own controller.
 *
 * Split from `InstructorCoursesController` because it changes for a different reason: that
 * one grows when a course gains a field, this one grows when the *workflow* changes — and
 * the workflow is the part that gets an approval queue and, later, a moderator UI.
 *
 * Every route is a verb rather than a `PATCH { status }`. The state machine's edges have
 * names (`submit`, `withdraw`, `publish`), and naming them in the URL means the client
 * cannot ask for a transition that does not exist, and the access log reads as a history of
 * what people did rather than a list of identical PATCHes.
 */
@Roles('INSTRUCTOR', 'ADMIN')
@Controller('instructor/courses/:id')
export class CourseLifecycleController {
  constructor(private readonly lifecycle: CourseLifecycleService) {}

  /** The wizard's checklist. Cheap, and the reason a publish is never a surprise 422. */
  @Get('readiness')
  readiness(@Param('id') id: string, @Req() request: FastifyRequest): Promise<PublishReadiness> {
    return this.lifecycle.readiness(id, actorOf(request));
  }

  @Post('submit')
  @HttpCode(200)
  submit(@Param('id') id: string, @Req() request: FastifyRequest): Promise<InstructorCourse> {
    return this.transition(id, 'IN_REVIEW', request);
  }

  @Post('withdraw')
  @HttpCode(200)
  withdraw(@Param('id') id: string, @Req() request: FastifyRequest): Promise<InstructorCourse> {
    return this.transition(id, 'DRAFT', request);
  }

  /** Reviewer-only — see `COURSE_LIFECYCLE`, where the role is declared on the edge. */
  @Post('publish')
  @HttpCode(200)
  publish(@Param('id') id: string, @Req() request: FastifyRequest): Promise<InstructorCourse> {
    return this.transition(id, 'PUBLISHED', request);
  }

  @Post('unpublish')
  @HttpCode(200)
  unpublish(@Param('id') id: string, @Req() request: FastifyRequest): Promise<InstructorCourse> {
    return this.transition(id, 'DRAFT', request);
  }

  @Post('archive')
  @HttpCode(200)
  archive(@Param('id') id: string, @Req() request: FastifyRequest): Promise<InstructorCourse> {
    return this.transition(id, 'ARCHIVED', request);
  }

  /**
   * `withdraw` and `unpublish` both target DRAFT and are still two routes: the source state
   * decides which edge is taken, and the two edges emit different events. Collapsing them
   * would make the URL lie about one of them.
   */
  private transition(
    id: string,
    to: 'DRAFT' | 'IN_REVIEW' | 'PUBLISHED' | 'ARCHIVED',
    request: FastifyRequest,
  ): Promise<InstructorCourse> {
    return this.lifecycle.transition(id, to, actorOf(request)).then(toInstructorCourse);
  }
}
