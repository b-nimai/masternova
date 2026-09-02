import type { LectureKind } from '@masternova/db';

/**
 * The curriculum half of the course aggregate: sections and the lectures inside them.
 *
 * **Why this is not a `SectionRepository` plus a `LectureRepository`.** Sections and
 * lectures have no independent lifecycle — they are never fetched, authorized or deleted
 * without their course, and every write to one has to keep the course's `lectureCount` and
 * `totalDurationSeconds` rollups honest. A repository per table would let a caller insert a
 * lecture and leave the counters stale, and the catalog card would start lying. So the
 * repository is scoped to the aggregate, and `refreshRollups` is part of its contract
 * rather than something callers are trusted to remember.
 *
 * It *is* split from `ICourseWriter`, though, because they change for different reasons and
 * have different clients: the public read path and the pricing endpoint touch the course
 * row and never the curriculum (CLAUDE.md §1 I).
 *
 * Nine methods is more than the "prefer three 2-method interfaces" guidance likes, and the
 * split that would fix the count is the one described above — trading a real invariant for
 * a tidier number. The methods are also genuinely one role: every one of them is "mutate
 * the curriculum of one course, inside a transaction".
 */

export const CURRICULUM_READER = Symbol('CURRICULUM_READER');
export const CURRICULUM_WRITER = Symbol('CURRICULUM_WRITER');

export interface EditableLecture {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly kind: LectureKind;
  readonly position: number;
  readonly isPreview: boolean;
  readonly durationSeconds: number;
  readonly assetId: string | null;
  readonly articleBody: string | null;
}

export interface EditableSection {
  readonly id: string;
  readonly title: string;
  readonly position: number;
  readonly lectures: readonly EditableLecture[];
}

/** The whole curriculum, ordered, as the commands and the publish gate see it. */
export interface CurriculumAggregate {
  readonly courseId: string;
  readonly sections: readonly EditableSection[];
}

/** `id` is supplied only by a restore, which must bring a row back as itself. */
export type NewLectureRow = Omit<EditableLecture, 'id'> & { readonly id?: string };
export type NewSectionRow = Omit<EditableSection, 'id' | 'lectures'> & {
  readonly id?: string;
  readonly lectures: readonly NewLectureRow[];
};

export type LecturePatchRow = Partial<Omit<EditableLecture, 'id' | 'position'>>;

/** Where one row ends up. A lecture placement may also change its section — that is a move. */
export interface SectionPlacement {
  readonly sectionId: string;
  readonly position: number;
}
export interface LecturePlacement {
  readonly lectureId: string;
  readonly sectionId: string;
  readonly position: number;
}

export interface ICurriculumReader {
  /**
   * `executor` is not optional bookkeeping here: the command handlers read the aggregate
   * *inside* the transaction that is about to change it, and a read on the default
   * connection would see the state before the version claim locked the row.
   */
  load(courseId: string, executor?: unknown): Promise<CurriculumAggregate>;
}

export interface ICurriculumWriter {
  createSection(courseId: string, section: NewSectionRow, executor?: unknown): Promise<string>;
  renameSection(sectionId: string, title: string, executor?: unknown): Promise<void>;
  deleteSection(sectionId: string, executor?: unknown): Promise<void>;

  createLecture(sectionId: string, lecture: NewLectureRow, executor?: unknown): Promise<string>;
  updateLecture(lectureId: string, patch: LecturePatchRow, executor?: unknown): Promise<void>;
  deleteLecture(lectureId: string, executor?: unknown): Promise<void>;

  /**
   * Both take the **complete** new layout of every row they touch, not a delta.
   *
   * The reason is the `@@unique([courseId, position])` constraint, which Postgres checks
   * per statement and Prisma cannot declare DEFERRABLE. Swapping two rows one UPDATE at a
   * time therefore violates it halfway through. Handing the repository the whole target
   * layout lets it park the rows on negative positions first and settle them second, which
   * is correct for a swap, a drag across sections, and a full reverse alike.
   */
  resequenceSections(placements: readonly SectionPlacement[], executor?: unknown): Promise<void>;
  resequenceLectures(placements: readonly LecturePlacement[], executor?: unknown): Promise<void>;

  /**
   * Recomputes `lectureCount` and `totalDurationSeconds` on the course row.
   *
   * Recomputed from the rows rather than incremented by a delta, on purpose: a delta is
   * only correct if every past delta was, and a single missed one is invisible until an
   * instructor emails about a course card claiming 41 lectures. A dozen-row aggregate in
   * the same transaction costs nothing and cannot drift.
   */
  refreshRollups(courseId: string, executor?: unknown): Promise<void>;
}
