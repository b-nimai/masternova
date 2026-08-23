import { Controller, Get, Param, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  courseListQuerySchema,
  type CourseDetail,
  type CourseListQuery,
  type CourseListResponse,
} from '@masternova/shared';
import { ZodQuery } from '../../common/pipes/zod-query.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CourseCatalogService } from './course-catalog.service';
import type { Viewer } from './specifications/course-specifications';

/**
 * The public catalog. Thin by design: parse, delegate, map (CLAUDE.md §4).
 *
 * `@Public()` means the global guard lets anonymous visitors through, but the JWT is still
 * decoded when present — so a signed-in instructor browsing the catalog sees their own
 * drafts, and a stranger does not. That distinction is made once, by `visibleTo`, and it is
 * part of the SQL rather than a filter applied afterwards.
 */
@Controller('courses')
export class CoursesController {
  constructor(private readonly catalog: CourseCatalogService) {}

  @Public()
  @Get()
  list(
    @ZodQuery(courseListQuerySchema) query: CourseListQuery,
    @Req() request: FastifyRequest,
  ): Promise<CourseListResponse> {
    return this.catalog.list(query, viewerOf(request));
  }

  @Public()
  @Get(':slug')
  findOne(@Param('slug') slug: string, @Req() request: FastifyRequest): Promise<CourseDetail> {
    return this.catalog.findBySlug(slug, viewerOf(request));
  }
}

/**
 * A `@Public()` route still gets `request.userId` when a valid cookie happens to be present:
 * `JwtAuthGuard` identifies the caller best-effort before letting a public route through,
 * so an optional viewer needs no second guard. An unreadable or expired token simply means
 * anonymous here.
 */
function viewerOf(request: FastifyRequest): Viewer | undefined {
  return request.userId && request.userRole
    ? { id: request.userId, role: request.userRole }
    : undefined;
}
