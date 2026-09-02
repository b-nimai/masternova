import { Inject, Injectable } from '@nestjs/common';
import { UNIT_OF_WORK, type TransactionContext, type UnitOfWork } from '@masternova/contracts';
import {
  curriculumInverseSchema,
  type Curriculum,
  type CurriculumCommand,
  type CurriculumEditRequest,
} from '@masternova/shared';
import { CourseVersionConflictException, NothingToUndoException } from '../../../common/exceptions';
import { COURSE_WRITER, type ICourseWriter } from '../repositories/course.writer.interface';
import {
  CURRICULUM_READER,
  CURRICULUM_WRITER,
  type ICurriculumReader,
  type ICurriculumWriter,
} from '../repositories/curriculum.repository.interface';
import {
  COURSE_EDIT_LOG,
  type ICourseEditLog,
} from '../repositories/edit-log.repository.interface';
import { CourseAccessService } from '../course-access.service';
import type { Actor } from '../actor';
import { applyCommand } from './curriculum-commands';

/**
 * The wizard's write path: apply one curriculum command, or undo the last one.
 *
 * Three public methods, and the reason it is only three despite there being nine kinds of
 * edit is the Command union — every new edit type is a handler, not a method here
 * (CLAUDE.md §1 O, §3's ~200-line rule).
 *
 * The transaction shape is the interesting part and it is the same both ways:
 *
 * 1. **claim the version first.** It validates optimistic concurrency *and* takes the course
 *    row's lock in one statement, so two autosaves cannot interleave their writes.
 * 2. read the aggregate — now genuinely stable, because of step 1.
 * 3. apply the command; it returns its own inverse, computed against that read.
 * 4. refresh the rollups from the rows, so the catalog card cannot drift.
 * 5. record the edit and its inverse; publish the event.
 *
 * All five commit together or none do. A half-applied drag, or an edit recorded with no
 * inverse, is not a state the database can be left in.
 */
@Injectable()
export class CurriculumService {
  constructor(
    private readonly access: CourseAccessService,
    @Inject(COURSE_WRITER) private readonly courses: ICourseWriter,
    @Inject(CURRICULUM_READER) private readonly reader: ICurriculumReader,
    @Inject(CURRICULUM_WRITER) private readonly writer: ICurriculumWriter,
    @Inject(COURSE_EDIT_LOG) private readonly editLog: ICourseEditLog,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async get(courseId: string, actor: Actor): Promise<Curriculum> {
    const course = await this.access.assertOwned(courseId, actor);
    return this.snapshot(courseId, course.version);
  }

  async apply(courseId: string, request: CurriculumEditRequest, actor: Actor): Promise<Curriculum> {
    await this.access.assertEditable(courseId, actor);

    return this.uow.execute(async (ctx) => {
      const version = await this.claim(courseId, request.expectedVersion, ctx.executor);
      const before = await this.reader.load(courseId, ctx.executor);

      const inverse = await applyCommand(request.command, before, {
        courseId,
        writer: this.writer,
        executor: ctx.executor,
      });

      await this.writer.refreshRollups(courseId, ctx.executor);
      await this.editLog.record(
        { courseId, actorId: actor.id, command: request.command, inverse, version },
        ctx.executor,
      );

      this.announce(ctx, courseId, version, request.command.kind);
      return this.snapshot(courseId, version, ctx.executor);
    });
  }

  /**
   * Pops the top of the stack and applies the stored inverse.
   *
   * The undo is deliberately **not** itself logged as an edit. Logging it would make the
   * next undo revert the undo, and the button would flip between two states forever instead
   * of walking back through the history — which is what anyone pressing it expects.
   *
   * It takes no `expectedVersion`. There is nothing to lose: undo does not carry a client's
   * stale copy of the content, it replays a reversal the server computed itself. It still
   * bumps the version, so any tab holding the pre-undo state is correctly told it is behind.
   */
  async undo(courseId: string, actor: Actor): Promise<Curriculum> {
    await this.access.assertEditable(courseId, actor);

    return this.uow.execute(async (ctx) => {
      // Unconditional bump, but still first: it is what locks the row, so an autosave racing
      // this undo waits rather than applying its command to a curriculum being rewound.
      const version = await this.courses.bumpVersion(courseId, ctx.executor);

      const entry = await this.editLog.peek(courseId, ctx.executor);
      if (!entry) throw new NothingToUndoException();

      // Re-parsed rather than cast: the column is `Json`, and a value written by an older
      // deploy is exactly the input a cast would wave through and a handler would crash on.
      const inverse = curriculumInverseSchema.parse(entry.inverse);
      const before = await this.reader.load(courseId, ctx.executor);

      await applyCommand(inverse, before, {
        courseId,
        writer: this.writer,
        executor: ctx.executor,
      });

      await this.writer.refreshRollups(courseId, ctx.executor);
      await this.editLog.markUndone(entry.id, ctx.executor);

      this.announce(ctx, courseId, version, 'UNDO');
      return this.snapshot(courseId, version, ctx.executor);
    });
  }

  private async claim(
    courseId: string,
    expectedVersion: number,
    executor: unknown,
  ): Promise<number> {
    const claim = await this.courses.claimVersion(courseId, expectedVersion, executor);
    if (!claim.claimed) {
      throw new CourseVersionConflictException(expectedVersion, claim.currentVersion);
    }
    return claim.version;
  }

  /**
   * One event for every curriculum change, carrying the kind rather than a per-edit
   * vocabulary. The search indexer (task 1.13) needs exactly one message meaning "reindex
   * this course", and a `catalog.course.lecture-moved` type would make adding an edit kind a
   * cross-context change.
   */
  private announce(
    ctx: TransactionContext,
    courseId: string,
    version: number,
    kind: CurriculumCommand['kind'] | 'UNDO',
  ): void {
    ctx.publish({
      type: 'catalog.course.curriculum-changed',
      aggregateType: 'Course',
      aggregateId: courseId,
      payload: { courseId, version, edit: kind },
    });
  }

  private async snapshot(
    courseId: string,
    version: number,
    executor?: unknown,
  ): Promise<Curriculum> {
    // Sequential, not `Promise.all`: `executor` is an interactive Prisma transaction, and
    // firing two queries at it concurrently is not something that client promises to survive.
    const curriculum = await this.reader.load(courseId, executor);
    const canUndo = await this.editLog.hasUndoable(courseId, executor);

    return {
      courseId,
      version,
      canUndo,
      sections: curriculum.sections.map((section) => ({
        id: section.id,
        title: section.title,
        position: section.position,
        lectures: section.lectures.map((lecture) => ({
          id: lecture.id,
          title: lecture.title,
          description: lecture.description,
          kind: lecture.kind,
          position: lecture.position,
          isPreview: lecture.isPreview,
          durationSeconds: lecture.durationSeconds,
          assetId: lecture.assetId,
          articleBody: lecture.articleBody,
        })),
      })),
    };
  }
}
