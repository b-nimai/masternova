import { Inject, Injectable } from '@nestjs/common';
import type {
  CourseDetail,
  CourseListQuery,
  CourseListResponse,
  InstructorCourseListQuery,
} from '@masternova/shared';
import { CourseNotFoundException } from '../../common/exceptions';
import {
  COURSE_READER,
  type CursorPage,
  type ICourseReader,
} from './repositories/course.reader.interface';
import {
  CATEGORY_REPOSITORY,
  type ICategoryRepository,
} from './repositories/category.repository.interface';
import { and, type CourseSpecification } from './specifications/course-specification';
import {
  atLevel,
  byInstructor,
  hasStatus,
  hasTopic,
  inCategoryTree,
  inLanguage,
  isFree,
  priceBetween,
  ratedAtLeast,
  titleMatches,
  visibleTo,
  type Viewer,
} from './specifications/course-specifications';
import { after, decodeCursor } from './cursor';

/**
 * The read side of the catalog: turn a query string into a specification, page it, map it.
 *
 * It is the only place that knows how an HTTP query maps onto rules. The repository knows
 * how to run a rule, the specifications know what a rule means, and neither knows the
 * other's job.
 */
@Injectable()
export class CourseCatalogService {
  constructor(
    @Inject(COURSE_READER) private readonly courses: ICourseReader,
    @Inject(CATEGORY_REPOSITORY) private readonly categories: ICategoryRepository,
  ) {}

  async list(query: CourseListQuery, viewer?: Viewer): Promise<CourseListResponse> {
    const spec = and(visibleTo(viewer), ...(await this.filtersFrom(query)));
    return this.courses.list(spec, this.pageFrom(query));
  }

  /** The instructor dashboard: my courses, any status, optionally filtered by one. */
  listMine(query: InstructorCourseListQuery, instructorId: string): Promise<CourseListResponse> {
    const spec = and(
      byInstructor(instructorId),
      ...(query.status ? [hasStatus(query.status)] : []),
    );
    // `RECENT` (updatedAt), not `NEWEST` (publishedAt): a dashboard is mostly drafts, and
    // a draft has no publish date to sort by. It is also the sort the
    // `(instructorId, updatedAt DESC)` index serves.
    return this.courses.list(spec, this.pageFrom({ ...query, sort: 'RECENT' }));
  }

  async findBySlug(slug: string, viewer?: Viewer): Promise<CourseDetail> {
    const course = await this.courses.findBySlug(slug, visibleTo(viewer));
    if (!course) throw new CourseNotFoundException();
    return course;
  }

  /**
   * A category filter is given as a slug and expands to the whole subtree, so browsing
   * "DevOps" includes "Kubernetes" beneath it. An unknown slug matches nothing rather than
   * 404ing the whole list — a stale bookmark should return an empty catalog, not an error.
   */
  private async filtersFrom(query: CourseListQuery): Promise<CourseSpecification[]> {
    const specs: CourseSpecification[] = [];

    if (query.q) specs.push(titleMatches(query.q));
    if (query.level) specs.push(atLevel(query.level));
    if (query.language) specs.push(inLanguage(query.language));
    if (query.topic) specs.push(hasTopic(query.topic));
    if (query.minRating !== undefined) specs.push(ratedAtLeast(query.minRating));
    if (query.free) specs.push(isFree());

    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      specs.push(priceBetween(query.minPrice ?? 0, query.maxPrice ?? Number.MAX_SAFE_INTEGER));
    }

    if (query.category) {
      const category = await this.categories.findBySlug(query.category);
      specs.push(
        inCategoryTree(
          category ? [category.id, ...category.children.map((child) => child.id)] : [],
        ),
      );
    }

    return specs;
  }

  /** Decoding happens here so the repository never parses a string it did not issue. */
  private pageFrom(query: {
    sort: CourseListQuery['sort'];
    limit: number;
    cursor?: string;
  }): CursorPage {
    return {
      sort: query.sort,
      limit: query.limit,
      after: query.cursor ? after(decodeCursor(query.cursor, query.sort)) : undefined,
    };
  }
}
