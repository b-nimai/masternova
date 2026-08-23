import { Inject, Injectable } from '@nestjs/common';
import type { Course, CourseStatus, Role } from '@masternova/db';
import { UNIT_OF_WORK, type UnitOfWork } from '@masternova/contracts';
import type { CoursePricingInput, CreateCourseInput, UpdateCourseInput } from '@masternova/shared';
import { slugify } from '../../common/utils/slug';
import {
  CourseNotFoundException,
  IllegalCourseTransitionException,
  NotCourseOwnerException,
} from '../../common/exceptions';
import { COURSE_WRITER, type ICourseWriter } from './repositories/course.writer.interface';
import { COURSE_READER, type ICourseReader } from './repositories/course.reader.interface';

/**
 * The write side: create a course, edit its details, price it, move its status.
 *
 * **Scope boundary, stated because it is a decision and not an omission.** The draft state
 * machine, per-step validation, the publish gate ("every section has ≥1 lecture, all media
 * READY, price set") and optimistic-concurrency autosave are task 1.5. This service ships
 * the one guard that is true regardless of those rules — `ARCHIVED` is terminal — and the
 * events. Task 1.5 replaces the guard with the State machine and no event name moves.
 *
 * Pricing is a separate method and a separate endpoint from the rest of the details,
 * because it changes for a different reason and emits a different event (CLAUDE.md §1 S).
 * What a price *should be* — coupons, tax, regional pricing — belongs to `PricingService`
 * in commerce (task 1.9). Catalog stores a number; it does not compute one.
 */
@Injectable()
export class CourseEditingService {
  constructor(
    @Inject(COURSE_WRITER) private readonly courses: ICourseWriter,
    // Reads and writes are injected separately, and the constructor says so — this
    // service genuinely needs both roles, which is exactly when a split is worth having.
    @Inject(COURSE_READER) private readonly reader: ICourseReader,
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

  async updateDetails(id: string, input: UpdateCourseInput, actor: Actor): Promise<Course> {
    await this.assertOwned(id, actor);

    return this.uow.execute(async (ctx) => {
      const course = await this.courses.updateDetails(id, input, ctx.executor);

      ctx.publish({
        type: 'catalog.course.updated',
        aggregateType: 'Course',
        aggregateId: id,
        // A list of changed fields rather than one event per field: the search indexer
        // needs exactly one message meaning "reindex this", and a per-field vocabulary
        // would make adding a column a cross-context change.
        payload: { courseId: id, changed: Object.keys(input) },
      });

      return course;
    });
  }

  async updatePricing(id: string, input: CoursePricingInput, actor: Actor): Promise<Course> {
    const existing = await this.assertOwned(id, actor);

    return this.uow.execute(async (ctx) => {
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
   * Moves a course's status, and publishes the event that the search index and the
   * entitlement cache both react to.
   */
  async setStatus(id: string, status: CourseStatus, actor: Actor): Promise<Course> {
    const existing = await this.assertOwned(id, actor);
    assertLegal(existing.status, status);

    return this.uow.execute(async (ctx) => {
      const course = await this.courses.setStatus(id, status, ctx.executor);

      ctx.publish({
        type: EVENT_FOR_STATUS[status],
        aggregateType: 'Course',
        aggregateId: id,
        payload: {
          courseId: id,
          instructorId: course.instructorId,
          slug: course.slug,
          previousStatus: existing.status,
          publishedAt: course.publishedAt?.toISOString() ?? null,
        },
      });

      return course;
    });
  }

  /**
   * Ownership, not just existence.
   *
   * Uses `findById`, which ignores visibility, because this is an authorization check that
   * must see the row as it is — including the statuses `visibleTo` would hide from the
   * very person who owns them.
   */
  private async assertOwned(id: string, actor: Actor): Promise<Course> {
    const course = await this.reader.findById(id);
    if (!course) throw new CourseNotFoundException();
    if (actor.role !== 'ADMIN' && course.instructorId !== actor.id) {
      throw new NotCourseOwnerException();
    }
    return course;
  }
}

export interface Actor {
  readonly id: string;
  readonly role: Role;
}

const EVENT_FOR_STATUS: Record<CourseStatus, string> = {
  DRAFT: 'catalog.course.unpublished',
  IN_REVIEW: 'catalog.course.unpublished',
  PUBLISHED: 'catalog.course.published',
  ARCHIVED: 'catalog.course.archived',
};

/**
 * The whole state machine task 1.4 ships, and it is one rule: archiving is terminal.
 *
 * Everything else — DRAFT → IN_REVIEW → PUBLISHED and back — is legal here and gains its
 * real preconditions in task 1.5, where the publish gate lives. Writing a half state
 * machine now would mean writing it twice.
 */
function assertLegal(from: CourseStatus, to: CourseStatus): void {
  if (from === 'ARCHIVED' && to !== 'ARCHIVED') {
    throw new IllegalCourseTransitionException(from, to);
  }
}
