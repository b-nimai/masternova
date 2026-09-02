import type { CurriculumCommand, CurriculumInverse } from '@masternova/shared';

/**
 * The undo stack, per course.
 *
 * Its own interface rather than a corner of the curriculum writer because it changes for a
 * different reason and has a different client: undo is one service method, the curriculum
 * writer is nine, and an audit log is the sort of thing that later grows a retention policy
 * and an admin read path that have nothing to do with editing (CLAUDE.md §1 I).
 */
export const COURSE_EDIT_LOG = Symbol('COURSE_EDIT_LOG');

export interface NewCourseEdit {
  readonly courseId: string;
  readonly actorId: string;
  readonly command: CurriculumCommand;
  readonly inverse: CurriculumInverse;
  /** The course version this edit produced — also the stack order. */
  readonly version: number;
}

export interface CourseEditEntry {
  readonly id: string;
  /** Still `unknown`: a JSON column is not a type, and the caller re-parses it with Zod. */
  readonly inverse: unknown;
}

export interface ICourseEditLog {
  record(edit: NewCourseEdit, executor?: unknown): Promise<void>;
  /** The top of the stack: the highest-versioned edit not yet undone. */
  peek(courseId: string, executor?: unknown): Promise<CourseEditEntry | null>;
  markUndone(id: string, executor?: unknown): Promise<void>;
  /** Drives the wizard's undo button, so it is never enabled over an empty stack. */
  hasUndoable(courseId: string, executor?: unknown): Promise<boolean>;
}
