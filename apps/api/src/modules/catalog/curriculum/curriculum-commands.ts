import type { CurriculumInverse, LectureDraft } from '@masternova/shared';
import {
  CurriculumNodeNotFoundException,
  InvalidReorderException,
} from '../../../common/exceptions';
import type {
  CurriculumAggregate,
  EditableLecture,
  EditableSection,
  ICurriculumWriter,
  LecturePlacement,
  NewLectureRow,
  SectionPlacement,
} from '../repositories/curriculum.repository.interface';

/**
 * Curriculum edits as **Command** objects.
 *
 * **The force, and it is undo.** The wizard lets an instructor drag forty lectures around
 * and delete a section by mistake, and the only acceptable answer to the mistake is Ctrl-Z.
 * Undo needs the edit to be a *value*: something that can be stored, and paired with the
 * operation that reverses it. Nine REST verbs cannot be reversed — a `DELETE` leaves nothing
 * behind — so the edit became an object, one route accepts the union, and every handler
 * returns the inverse of what it just did.
 *
 * **Why apply and invert are one method.** The inverse of "remove section 3" is "put section
 * 3 back with these four lectures at these positions", and that information exists only in
 * the instant before the delete runs. Two methods would mean loading the aggregate twice and
 * trusting nothing changed between them. One method that receives the state it is about to
 * destroy, and hands back the reversal, cannot get that wrong. Creates need the same shape
 * for the mirror reason: the id to remove does not exist until the insert has run.
 *
 * **Where the next edit type plugs in** (the seam): add a member to
 * `curriculumCommandSchema` and an entry to `HANDLERS`. The controller, the service, the
 * undo path and the edit log are untouched (CLAUDE.md §1 O).
 *
 * Everything here is pure domain logic over an injected writer — no Prisma, no Nest, no
 * request. That is what lets the whole command set be tested against an in-memory fake.
 */

/**
 * Positions are spaced so an insert between two rows does not renumber the course.
 *
 * The gap is only an optimisation for appends; every reorder resequences the whole list
 * anyway, because that is the only way to be correct under the unique constraint.
 */
export const POSITION_GAP = 10;

export interface CommandContext {
  readonly courseId: string;
  readonly writer: ICurriculumWriter;
  readonly executor: unknown;
}

/**
 * Applies the command and returns the command that would undo it.
 *
 * `before` is the aggregate as it stands inside the transaction, already locked by the
 * version claim, so it is a true picture and not a stale read.
 */
export type CurriculumCommandHandler<K extends CurriculumInverse['kind']> = (
  command: Extract<CurriculumInverse, { kind: K }>,
  before: CurriculumAggregate,
  ctx: CommandContext,
) => Promise<CurriculumInverse>;

type HandlerMap = { [K in CurriculumInverse['kind']]: CurriculumCommandHandler<K> };

// ── lookups that fail the same way everywhere ──────────────────────────────

const sectionOf = (before: CurriculumAggregate, sectionId: string): EditableSection => {
  const section = before.sections.find((candidate) => candidate.id === sectionId);
  // Scoped to the aggregate, so an id belonging to another instructor's course is a 404
  // here rather than a successful cross-course write. The ownership check upstream proves
  // the *course* is yours; this is what proves the *node* is in it.
  if (!section) throw new CurriculumNodeNotFoundException();
  return section;
};

const locate = (
  before: CurriculumAggregate,
  lectureId: string,
): { section: EditableSection; lecture: EditableLecture } => {
  for (const section of before.sections) {
    const lecture = section.lectures.find((candidate) => candidate.id === lectureId);
    if (lecture) return { section, lecture };
  }
  throw new CurriculumNodeNotFoundException();
};

const nextPosition = (rows: readonly { position: number }[]): number =>
  rows.length === 0 ? POSITION_GAP : Math.max(...rows.map((row) => row.position)) + POSITION_GAP;

/** A reorder must be a permutation of what is there — see `InvalidReorderException`. */
const assertPermutationOf = (present: readonly string[], requested: readonly string[]): void => {
  const unique = new Set(requested);
  if (
    unique.size !== requested.length ||
    unique.size !== present.length ||
    present.some((id) => !unique.has(id))
  ) {
    throw new InvalidReorderException();
  }
};

const sectionPlacements = (orderedIds: readonly string[]): SectionPlacement[] =>
  orderedIds.map((sectionId, index) => ({
    sectionId,
    position: (index + 1) * POSITION_GAP,
  }));

const lecturePlacements = (sectionId: string, orderedIds: readonly string[]): LecturePlacement[] =>
  orderedIds.map((lectureId, index) => ({
    lectureId,
    sectionId,
    position: (index + 1) * POSITION_GAP,
  }));

const draftOf = (lecture: EditableLecture): LectureDraft => ({
  title: lecture.title,
  description: lecture.description,
  kind: lecture.kind,
  isPreview: lecture.isPreview,
  durationSeconds: lecture.durationSeconds,
  assetId: lecture.assetId,
  articleBody: lecture.articleBody,
});

const rowOf = (draft: LectureDraft, position: number, id?: string): NewLectureRow => ({
  ...draft,
  position,
  id,
});

/**
 * A restore puts a row back at the position it held.
 *
 * Deletes leave their gap behind precisely so that slot is still free. If a later edit did
 * take it — an append that landed on the same number after several removals — the row goes
 * to the end instead. Correct order beats exact order: a unique-constraint violation would
 * fail the whole undo, and an instructor who undid a delete wants the lecture back, not an
 * error about position 30.
 */
const freePosition = (taken: readonly { position: number }[], preferred: number): number =>
  taken.some((row) => row.position === preferred) ? nextPosition(taken) : preferred;

// ── the handlers ───────────────────────────────────────────────────────────

const HANDLERS: HandlerMap = {
  ADD_SECTION: async (command, before, ctx) => {
    const id = await ctx.writer.createSection(
      ctx.courseId,
      { title: command.title, position: nextPosition(before.sections), lectures: [] },
      ctx.executor,
    );
    return { kind: 'REMOVE_SECTION', sectionId: id };
  },

  RENAME_SECTION: async (command, before, ctx) => {
    const section = sectionOf(before, command.sectionId);
    await ctx.writer.renameSection(section.id, command.title, ctx.executor);
    return { kind: 'RENAME_SECTION', sectionId: section.id, title: section.title };
  },

  REMOVE_SECTION: async (command, before, ctx) => {
    const section = sectionOf(before, command.sectionId);
    await ctx.writer.deleteSection(section.id, ctx.executor);
    return {
      kind: 'RESTORE_SECTION',
      section: {
        id: section.id,
        title: section.title,
        position: section.position,
        lectures: section.lectures.map((lecture) => ({
          ...draftOf(lecture),
          id: lecture.id,
          position: lecture.position,
        })),
      },
    };
  },

  /**
   * Only ever produced as the inverse of a removal — it is not in `curriculumCommandSchema`,
   * because a client that could send it would be choosing its own primary keys.
   */
  RESTORE_SECTION: async (command, before, ctx) => {
    const { section } = command;
    const id = await ctx.writer.createSection(
      ctx.courseId,
      {
        id: section.id,
        title: section.title,
        position: freePosition(before.sections, section.position),
        lectures: section.lectures.map((lecture) => rowOf(lecture, lecture.position, lecture.id)),
      },
      ctx.executor,
    );
    return { kind: 'REMOVE_SECTION', sectionId: id };
  },

  REORDER_SECTIONS: async (command, before, ctx) => {
    const present = before.sections.map((section) => section.id);
    assertPermutationOf(present, command.sectionIds);
    await ctx.writer.resequenceSections(sectionPlacements(command.sectionIds), ctx.executor);
    return { kind: 'REORDER_SECTIONS', sectionIds: present };
  },

  ADD_LECTURE: async (command, before, ctx) => {
    const section = sectionOf(before, command.sectionId);
    const id = await ctx.writer.createLecture(
      section.id,
      rowOf(command.lecture, nextPosition(section.lectures)),
      ctx.executor,
    );
    return { kind: 'REMOVE_LECTURE', lectureId: id };
  },

  UPDATE_LECTURE: async (command, before, ctx) => {
    const { lecture } = locate(before, command.lectureId);
    await ctx.writer.updateLecture(lecture.id, command.patch, ctx.executor);

    // The inverse patches back exactly the fields this one touched, and no others — undoing
    // a title edit must not also revert a duration the same command left alone.
    const previous = draftOf(lecture);
    const restored = Object.fromEntries(
      Object.keys(command.patch).map((field) => [field, previous[field as keyof LectureDraft]]),
    );
    return { kind: 'UPDATE_LECTURE', lectureId: lecture.id, patch: restored };
  },

  REMOVE_LECTURE: async (command, before, ctx) => {
    const { section, lecture } = locate(before, command.lectureId);
    await ctx.writer.deleteLecture(lecture.id, ctx.executor);
    return {
      kind: 'RESTORE_LECTURE',
      sectionId: section.id,
      lecture: { ...draftOf(lecture), id: lecture.id, position: lecture.position },
    };
  },

  RESTORE_LECTURE: async (command, before, ctx) => {
    const section = sectionOf(before, command.sectionId);
    const id = await ctx.writer.createLecture(
      section.id,
      rowOf(
        command.lecture,
        freePosition(section.lectures, command.lecture.position),
        command.lecture.id,
      ),
      ctx.executor,
    );
    return { kind: 'REMOVE_LECTURE', lectureId: id };
  },

  /**
   * The interesting one: a drag that may cross sections.
   *
   * Both affected sections are resequenced in one call, because the destination and the
   * source have to be settled inside the same two-pass window — otherwise the lecture is
   * briefly in neither list, or in both.
   */
  MOVE_LECTURE: async (command, before, ctx) => {
    const { section: from, lecture } = locate(before, command.lectureId);
    const to = sectionOf(before, command.toSectionId);

    const sourceIds = from.lectures
      .map((candidate) => candidate.id)
      .filter((id) => id !== lecture.id);
    const targetIds = (from.id === to.id ? sourceIds : to.lectures.map((c) => c.id)).slice();
    // `toIndex` past the end clamps to an append rather than 400ing: the client computed it
    // from a list that may have shrunk, and "drop it at the bottom" is what was meant.
    targetIds.splice(Math.min(command.toIndex, targetIds.length), 0, lecture.id);

    await ctx.writer.resequenceLectures(
      [
        ...lecturePlacements(to.id, targetIds),
        ...(from.id === to.id ? [] : lecturePlacements(from.id, sourceIds)),
      ],
      ctx.executor,
    );

    return {
      kind: 'MOVE_LECTURE',
      lectureId: lecture.id,
      toSectionId: from.id,
      toIndex: from.lectures.findIndex((candidate) => candidate.id === lecture.id),
    };
  },
};

/** Resolution by discriminator. Total over the union, so a new member cannot be forgotten. */
export function applyCommand(
  command: CurriculumInverse,
  before: CurriculumAggregate,
  ctx: CommandContext,
): Promise<CurriculumInverse> {
  const handler = HANDLERS[command.kind] as CurriculumCommandHandler<typeof command.kind>;
  return handler(command as never, before, ctx);
}
