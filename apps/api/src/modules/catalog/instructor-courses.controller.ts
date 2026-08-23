import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  coursePricingSchema,
  createCourseSchema,
  instructorCourseListQuerySchema,
  updateCourseSchema,
  type CoursePricingInput,
  type CourseListResponse,
  type CreateCourseInput,
  type InstructorCourseListQuery,
  type UpdateCourseInput,
  type InstructorCourse,
} from '@masternova/shared';
import type { Role } from '@masternova/db';
import { ZodBody } from '../../common/pipes/zod-body.decorator';
import { ZodQuery } from '../../common/pipes/zod-query.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { CourseCatalogService } from './course-catalog.service';
import { CourseEditingService, type Actor } from './course-editing.service';
import { CourseDuplicationService } from './course-duplication.service';
import { toInstructorCourse } from './course.mapper';

/**
 * The authoring surface, separated from the public read controller rather than folded in
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
    @ZodBody(updateCourseSchema) body: UpdateCourseInput,
    @Req() request: FastifyRequest,
  ): Promise<InstructorCourse> {
    return this.editing.updateDetails(id, body, actorOf(request)).then(toInstructorCourse);
  }

  /** Its own route because pricing changes for its own reason and emits its own event. */
  @Patch(':id/pricing')
  updatePricing(
    @Param('id') id: string,
    @ZodBody(coursePricingSchema) body: CoursePricingInput,
    @Req() request: FastifyRequest,
  ): Promise<InstructorCourse> {
    return this.editing.updatePricing(id, body, actorOf(request)).then(toInstructorCourse);
  }

  @Post(':id/publish')
  @HttpCode(200)
  publish(@Param('id') id: string, @Req() request: FastifyRequest): Promise<InstructorCourse> {
    return this.editing.setStatus(id, 'PUBLISHED', actorOf(request)).then(toInstructorCourse);
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  unpublish(@Param('id') id: string, @Req() request: FastifyRequest): Promise<InstructorCourse> {
    return this.editing.setStatus(id, 'DRAFT', actorOf(request)).then(toInstructorCourse);
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(@Param('id') id: string, @Req() request: FastifyRequest): Promise<InstructorCourse> {
    return this.editing.setStatus(id, 'ARCHIVED', actorOf(request)).then(toInstructorCourse);
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

function actorOf(request: FastifyRequest): Actor {
  return { id: request.userId as string, role: request.userRole as Role };
}
