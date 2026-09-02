import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  coursePricingRequestSchema,
  createCourseSchema,
  instructorCourseListQuerySchema,
  updateCourseRequestSchema,
  type CoursePricingRequest,
  type CourseListResponse,
  type CreateCourseInput,
  type InstructorCourseListQuery,
  type UpdateCourseRequest,
  type InstructorCourse,
} from '@masternova/shared';
import { ZodBody } from '../../common/pipes/zod-body.decorator';
import { ZodQuery } from '../../common/pipes/zod-query.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { CourseCatalogService } from './course-catalog.service';
import { CourseEditingService } from './course-editing.service';
import { CourseDuplicationService } from './course-duplication.service';
import { toInstructorCourse } from './course.mapper';
import { actorOf } from './actor.request';

/**
 * The course *row*: list it, create it, edit its fields, price it, copy it.
 *
 * Its lifecycle lives on `CourseLifecycleController` and its curriculum on
 * `CurriculumController` — three thin controllers over three services, each with one reason
 * to change, rather than one controller with fourteen routes.
 *
 * The authoring surface is separated from the public read controller rather than folded in
 * as `GET /courses/mine`.
 *
 * Two reasons. Route matching would be order-dependent — `/courses/mine` has to be declared
 * before `/courses/:slug` or it is swallowed by it — and that is a fragility nobody
 * remembers when adding the next route. And the public controller then has one reason to
 * change instead of two (CLAUDE.md §1 S).
 */
@Roles('INSTRUCTOR', 'ADMIN')
@Controller('instructor/courses')
export class InstructorCoursesController {
  constructor(
    private readonly catalog: CourseCatalogService,
    private readonly editing: CourseEditingService,
    private readonly duplication: CourseDuplicationService,
  ) {}

  @Get()
  list(
    @ZodQuery(instructorCourseListQuerySchema) query: InstructorCourseListQuery,
    @Req() request: FastifyRequest,
  ): Promise<CourseListResponse> {
    return this.catalog.listMine(query, actorOf(request).id);
  }

  @Post()
  create(
    @ZodBody(createCourseSchema) body: CreateCourseInput,
    @Req() request: FastifyRequest,
  ): Promise<InstructorCourse> {
    return this.editing.create(body, actorOf(request).id).then(toInstructorCourse);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @ZodBody(updateCourseRequestSchema) body: UpdateCourseRequest,
    @Req() request: FastifyRequest,
  ): Promise<InstructorCourse> {
    return this.editing.updateDetails(id, body, actorOf(request)).then(toInstructorCourse);
  }

  /** Its own route because pricing changes for its own reason and emits its own event. */
  @Patch(':id/pricing')
  updatePricing(
    @Param('id') id: string,
    @ZodBody(coursePricingRequestSchema) body: CoursePricingRequest,
    @Req() request: FastifyRequest,
  ): Promise<InstructorCourse> {
    return this.editing.updatePricing(id, body, actorOf(request)).then(toInstructorCourse);
  }

  /**
   * `@Idempotent()` because a double-clicked "Duplicate" button is exactly the retry the
   * interceptor exists for, and the second click would otherwise create a second copy that
   * the instructor then has to find and delete.
   *
   * `@Body()` with no schema so the interceptor's request hash has something stable to
   * hash; the body itself is unused.
   */
  @Post(':id/duplicate')
  @Idempotent()
  duplicate(
    @Param('id') id: string,
    @Body() _body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<InstructorCourse> {
    return this.duplication.duplicate(id, actorOf(request)).then(toInstructorCourse);
  }
}
