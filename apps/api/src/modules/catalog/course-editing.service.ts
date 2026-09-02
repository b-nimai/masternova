import { Inject, Injectable } from '@nestjs/common';
import type { Course } from '@masternova/db';
import { UNIT_OF_WORK, type UnitOfWork } from '@masternova/contracts';
import type {
  CoursePricingRequest,
  CreateCourseInput,
  UpdateCourseRequest,
} from '@masternova/shared';
import { slugify } from '../../common/utils/slug';
import { CourseVersionConflictException } from '../../common/exceptions';
import { COURSE_WRITER, type ICourseWriter } from './repositories/course.writer.interface';
import { CourseAccessService } from './course-access.service';
import type { Actor } from './actor';

/**
 * The course row's write side: create it, edit its details, price it.
 *
 * **What it no longer does.** Status transitions left with task 1.5 — they answer to the
 * state machine and the publish gate, which is a different reason to change, so they are
 * `CourseLifecycleService` (CLAUDE.md §1 S). Curriculum edits are `CurriculumService`. What
 * is left is three methods over one row.
 *
 * Pricing stays separate from the rest of the details because it changes for a different
 * reason and emits a different event. What a price *should be* — coupons, tax, regional
 * pricing — belongs to `PricingService` in commerce (task 1.9). Catalog stores a number; it
 * does not compute one.
 */
@Injectable()
export class CourseEditingService {
  constructor(
    @Inject(COURSE_WRITER) private readonly courses: ICourseWriter,
    private readonly access: CourseAccessService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async create(input: CreateCourseInput, instructorId: string): Promise<Course> {
    return this.uow.execute(async (ctx) => {
      const course = await this.courses.create(
        {
          slug: slugify(input.title),
          title: input.title,
          subtitle: input.subtitle,
          description: input.description,
          language: input.language,
          level: input.level,
          instructorId,
          categoryId: input.categoryId ?? null,
          topics: input.topics,
        },
        ctx.executor,
      );

      ctx.publish({
        type: 'catalog.course.created',
        aggregateType: 'Course',
        aggregateId: course.id,
        payload: { courseId: course.id, instructorId, title: course.title, slug: course.slug },
      });

      return course;
    });
  }

  async updateDetails(id: string, input: UpdateCourseRequest, actor: Actor): Promise<Course> {
    await this.access.assertEditable(id, actor);
    const { expectedVersion, ...patch } = input;

    return this.uow.execute(async (ctx) => {
      await this.claim(id, expectedVersion, ctx.executor);
      const course = await this.courses.updateDetails(id, patch, ctx.executor);

      ctx.publish({
        type: 'catalog.course.updated',
        aggregateType: 'Course',
        aggregateId: id,
        // A list of changed fields rather than one event per field: the search indexer
        // needs exactly one message meaning "reindex this", and a per-field vocabulary
        // would make adding a column a cross-context change.
        payload: { courseId: id, changed: Object.keys(patch) },
      });

      return course;
    });
  }

  async updatePricing(id: string, input: CoursePricingRequest, actor: Actor): Promise<Course> {
    const existing = await this.access.assertEditable(id, actor);

    return this.uow.execute(async (ctx) => {
      await this.claim(id, input.expectedVersion, ctx.executor);
      const course = await this.courses.updatePricing(
        id,
        {
          priceMinor: input.priceMinor,
          listPriceMinor: input.listPriceMinor,
          currency: input.currency,
        },
        ctx.executor,
      );

      ctx.publish({
        type: 'catalog.course.repriced',
        aggregateType: 'Course',
        aggregateId: id,
        // The previous price travels on the event because the consumer that needs it most
        // — a cart holding a stale price (task 1.9) — cannot ask what it used to be.
        payload: {
          courseId: id,
          priceMinor: course.priceMinor,
          listPriceMinor: course.listPriceMinor,
          currency: course.currency,
          previousPriceMinor: existing.priceMinor,
        },
      });

      return course;
    });
  }

  /**
   * Optimistic concurrency, and the row lock, as the first statement of the transaction —
   * the same claim `CurriculumService` makes, for the same reason. See `claimVersion`.
   */
  private async claim(id: string, expectedVersion: number, executor: unknown): Promise<number> {
    const claim = await this.courses.claimVersion(id, expectedVersion, executor);
    if (!claim.claimed) {
      throw new CourseVersionConflictException(expectedVersion, claim.currentVersion);
    }
    return claim.version;
  }
}
