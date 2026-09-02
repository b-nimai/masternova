import { Inject, Injectable } from '@nestjs/common';
import type { Course, CourseStatus } from '@masternova/db';
import { UNIT_OF_WORK, type UnitOfWork } from '@masternova/contracts';
import type { PublishReadiness } from '@masternova/shared';
import {
  CourseNotReadyException,
  IllegalCourseTransitionException,
  ReviewerRoleRequiredException,
} from '../../../common/exceptions';
import { COURSE_WRITER, type ICourseWriter } from '../repositories/course.writer.interface';
import {
  CURRICULUM_READER,
  type ICurriculumReader,
} from '../repositories/curriculum.repository.interface';
import { CourseAccessService } from '../course-access.service';
import type { Actor } from '../actor';
import { allowedFrom, transitionFrom } from './course-lifecycle';
import { readinessOf } from './publish-gate';

/**
 * Moves a course through its lifecycle, and answers "could it move?" before anyone tries.
 *
 * It owns no rules of its own — the legal edges live in `course-lifecycle.ts` and the
 * content rules in `publish-gate.ts`, both pure and both tested without a database. This
 * service is the part that cannot be pure: load the aggregate, ask the two of them, write
 * the result and the event in one transaction.
 *
 * Split out of `CourseEditingService`, which now does nothing but edit fields. They changed
 * for different reasons the moment the gate existed (CLAUDE.md §1 S).
 */
@Injectable()
export class CourseLifecycleService {
  constructor(
    private readonly access: CourseAccessService,
    @Inject(COURSE_WRITER) private readonly courses: ICourseWriter,
    @Inject(CURRICULUM_READER) private readonly curriculum: ICurriculumReader,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  /**
   * The wizard's checklist.
   *
   * Same requirement list the gate enforces, so the ticks the instructor sees and the reason
   * a transition is refused can never disagree — a mismatch between "everything looks done"
   * and a 422 is the bug this endpoint exists to make impossible.
   */
  async readiness(courseId: string, actor: Actor): Promise<PublishReadiness> {
    const course = await this.access.assertOwned(courseId, actor);
    const { ready, steps } = await this.gateFor(course);

    return {
      courseId: course.id,
      status: course.status,
      version: course.version,
      ready,
      allowedTransitions: allowedFrom(course.status),
      steps: steps.map((step) => ({ ...step, problems: [...step.problems] })),
    };
  }

  async transition(courseId: string, to: CourseStatus, actor: Actor): Promise<Course> {
    const course = await this.access.assertOwned(courseId, actor);

    const edge = transitionFrom(course.status, to);
    if (!edge) throw new IllegalCourseTransitionException(course.status, to);
    if (edge.requiresRole && actor.role !== edge.requiresRole) {
      throw new ReviewerRoleRequiredException();
    }

    if (edge.requiresPublishGate) {
      // Re-checked on approval, not only on submission: the course can be edited while it
      // sits in the review queue, so yesterday's green tick proves nothing about today.
      const gate = await this.gateFor(course);
      if (!gate.ready) throw new CourseNotReadyException(gate.problems);
    }

    return this.uow.execute(async (ctx) => {
      // The edge was validated against a row read outside this transaction. Applying the
      // move conditionally on that same state is what makes the validation binding: an
      // archive racing a publish — both legal from what each of them saw — cannot both
      // land, and the loser is told the transition is no longer available rather than
      // quietly overwriting a terminal state.
      const updated = await this.courses.setStatus(courseId, to, course.status, ctx.executor);
      if (!updated) throw new IllegalCourseTransitionException(course.status, to);

      ctx.publish({
        type: edge.event,
        aggregateType: 'Course',
        aggregateId: courseId,
        payload: {
          courseId,
          instructorId: updated.instructorId,
          slug: updated.slug,
          previousStatus: course.status,
          publishedAt: updated.publishedAt?.toISOString() ?? null,
        },
      });

      return updated;
    });
  }

  /** Two reads rather than one deep join: the gate needs the course row *and* its sections. */
  private async gateFor(course: Course) {
    const curriculum = await this.curriculum.load(course.id);
    return readinessOf({ ...course, sections: curriculum.sections });
  }
}
