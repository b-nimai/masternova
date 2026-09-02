import type { CurriculumCommand, CurriculumInverse } from '@masternova/shared';
import {
  CurriculumNodeNotFoundException,
  InvalidReorderException,
} from '../../../common/exceptions';
import type {
  CurriculumAggregate,
  EditableLecture,
  EditableSection,
  ICurriculumWriter,
  LecturePatchRow,
  LecturePlacement,
  NewLectureRow,
  NewSectionRow,
  SectionPlacement,
} from '../repositories/curriculum.repository.interface';
import { applyCommand, POSITION_GAP } from './curriculum-commands';

/**
 * The commands are tested against an in-memory writer, with no database anywhere.
 *
 * That is possible only because `CurriculumService` depends on `ICurriculumWriter` rather
 * than on Prisma (CLAUDE.md §1 D) — and it is the reason the interface exists at all. A
 * mock of `PrismaService` would prove that the right methods were called; this fake proves
 * the curriculum ends up in the right shape.
 */
class FakeCurriculum implements ICurriculumWriter {
  private counter = 0;
  rollupsRefreshed = 0;

  constructor(private sections: EditableSection[] = []) {}

  /** `new_` prefixed so a generated id can never collide with a seeded one in a test. */
  private id(prefix: string): string {
    this.counter += 1;
    return `new_${prefix}_${this.counter}`;
  }

  snapshot(): CurriculumAggregate {
    // Sorted on read, exactly as the repository's `orderBy: { position: 'asc' }` does, so
    // the fake cannot make a positioning bug invisible by preserving insertion order.
    return {
      courseId: 'course_1',
      sections: [...this.sections]
        .sort((a, b) => a.position - b.position)
        .map((section) => ({
          ...section,
          lectures: [...section.lectures].sort((a, b) => a.position - b.position),
        })),
    };
  }

  private sectionOrThrow(sectionId: string): EditableSection {
    const section = this.sections.find((candidate) => candidate.id === sectionId);
    if (!section) throw new Error(`fake: no section ${sectionId}`);
    return section;
  }

  createSection(_courseId: string, section: NewSectionRow): Promise<string> {
    const id = section.id ?? this.id('sec');
    this.assertFreeSectionPosition(section.position);
    this.sections.push({
      id,
      title: section.title,
      position: section.position,
      lectures: section.lectures.map((lecture) => ({
        ...lecture,
        id: lecture.id ?? this.id('lec'),
      })),
    });
    return Promise.resolve(id);
  }

  renameSection(sectionId: string, title: string): Promise<void> {
    const section = this.sectionOrThrow(sectionId);
    this.replaceSection({ ...section, title });
    return Promise.resolve();
  }

  deleteSection(sectionId: string): Promise<void> {
    this.sectionOrThrow(sectionId);
    this.sections = this.sections.filter((section) => section.id !== sectionId);
    return Promise.resolve();
  }

  createLecture(sectionId: string, lecture: NewLectureRow): Promise<string> {
    const section = this.sectionOrThrow(sectionId);
    const id = lecture.id ?? this.id('lec');
    this.assertFreeLecturePosition(section, lecture.position);
    this.replaceSection({
      ...section,
      lectures: [...section.lectures, { ...lecture, id }],
    });
    return Promise.resolve(id);
  }

  updateLecture(lectureId: string, patch: LecturePatchRow): Promise<void> {
    const { section, lecture } = this.locate(lectureId);
    this.replaceSection({
      ...section,
      lectures: section.lectures.map((candidate) =>
        candidate.id === lectureId ? { ...lecture, ...patch } : candidate,
      ),
    });
    return Promise.resolve();
  }

  deleteLecture(lectureId: string): Promise<void> {
    const { section } = this.locate(lectureId);
    this.replaceSection({
      ...section,
      lectures: section.lectures.filter((candidate) => candidate.id !== lectureId),
    });
    return Promise.resolve();
  }

  resequenceSections(placements: readonly SectionPlacement[]): Promise<void> {
    for (const placement of placements) {
      const section = this.sectionOrThrow(placement.sectionId);
      this.replaceSection({ ...section, position: placement.position });
    }
    this.assertNoDuplicatePositions();
    return Promise.resolve();
  }

  resequenceLectures(placements: readonly LecturePlacement[]): Promise<void> {
    for (const placement of placements) {
      const { section, lecture } = this.locate(placement.lectureId);
      this.replaceSection({
        ...section,
        lectures: section.lectures.filter((candidate) => candidate.id !== lecture.id),
      });
      const target = this.sectionOrThrow(placement.sectionId);
      this.replaceSection({
        ...target,
        lectures: [...target.lectures, { ...lecture, position: placement.position }],
      });
    }
    this.assertNoDuplicatePositions();
    return Promise.resolve();
  }

  refreshRollups(): Promise<void> {
    this.rollupsRefreshed += 1;
    return Promise.resolve();
  }

  private locate(lectureId: string): { section: EditableSection; lecture: EditableLecture } {
    for (const section of this.sections) {
      const lecture = section.lectures.find((candidate) => candidate.id === lectureId);
      if (lecture) return { section, lecture };
    }
    throw new Error(`fake: no lecture ${lectureId}`);
  }

  private replaceSection(next: EditableSection): void {
    this.sections = this.sections.map((section) => (section.id === next.id ? next : section));
  }

  /**
   * The fake enforces the same uniqueness the `@@unique([courseId, position])` constraints
   * do — otherwise a command that only works because Prisma is absent would pass here and
   * fail in production, which is precisely the failure a fake is supposed to prevent.
   */
  private assertNoDuplicatePositions(): void {
    const sectionPositions = this.sections.map((section) => section.position);
    if (new Set(sectionPositions).size !== sectionPositions.length) {
      throw new Error('fake: two sections share a position');
    }
    for (const section of this.sections) {
      const positions = section.lectures.map((lecture) => lecture.position);
      if (new Set(positions).size !== positions.length) {
        throw new Error(`fake: two lectures share a position in ${section.id}`);
      }
    }
  }

  private assertFreeSectionPosition(position: number): void {
    if (this.sections.some((section) => section.position === position)) {
      throw new Error('fake: two sections share a position');
    }
  }

  private assertFreeLecturePosition(section: EditableSection, position: number): void {
    if (section.lectures.some((lecture) => lecture.position === position)) {
      throw new Error(`fake: two lectures share a position in ${section.id}`);
    }
  }
}

const lecture = (id: string, position: number, over: Partial<EditableLecture> = {}) => ({
  id,
  title: `Lecture ${id}`,
  description: null,
  kind: 'VIDEO' as const,
  position,
  isPreview: false,
  durationSeconds: 60,
  assetId: `asset_${id}`,
  articleBody: null,
  ...over,
});

const startingCurriculum = (): EditableSection[] => [
  {
    id: 'sec_a',
    title: 'Alpha',
    position: 10,
    lectures: [lecture('lec_1', 10), lecture('lec_2', 20)],
  },
  { id: 'sec_b', title: 'Beta', position: 20, lectures: [lecture('lec_3', 10)] },
];

const run = async (fake: FakeCurriculum, command: CurriculumInverse): Promise<CurriculumInverse> =>
  applyCommand(command, fake.snapshot(), {
    courseId: 'course_1',
    writer: fake,
    executor: undefined,
  });

describe('curriculum commands', () => {
  describe('applying', () => {
    it('appends a section past the last position', async () => {
      const fake = new FakeCurriculum(startingCurriculum());
      await run(fake, { kind: 'ADD_SECTION', title: 'Gamma' });

      const sections = fake.snapshot().sections;
      expect(sections.map((section) => section.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
      expect(sections[2].position).toBe(20 + POSITION_GAP);
    });

    it('appends a lecture inside its section', async () => {
      const fake = new FakeCurriculum(startingCurriculum());
      await run(fake, {
        kind: 'ADD_LECTURE',
        sectionId: 'sec_b',
        lecture: {
          title: 'New',
          description: null,
          kind: 'VIDEO',
          isPreview: false,
          durationSeconds: 30,
          assetId: null,
          articleBody: null,
        },
      });

      expect(fake.snapshot().sections[1].lectures.map((l) => l.title)).toEqual([
        'Lecture lec_3',
        'New',
      ]);
    });

    it('moves a lecture into another section at the requested index', async () => {
      const fake = new FakeCurriculum(startingCurriculum());
      await run(fake, {
        kind: 'MOVE_LECTURE',
        lectureId: 'lec_1',
        toSectionId: 'sec_b',
        toIndex: 0,
      });

      const sections = fake.snapshot().sections;
      expect(sections[0].lectures.map((l) => l.id)).toEqual(['lec_2']);
      expect(sections[1].lectures.map((l) => l.id)).toEqual(['lec_1', 'lec_3']);
    });

    it('reorders within one section without tripping the position constraint', async () => {
      const fake = new FakeCurriculum(startingCurriculum());
      await run(fake, {
        kind: 'MOVE_LECTURE',
        lectureId: 'lec_2',
        toSectionId: 'sec_a',
        toIndex: 0,
      });

      expect(fake.snapshot().sections[0].lectures.map((l) => l.id)).toEqual(['lec_2', 'lec_1']);
    });

    it('clamps an out-of-range index to an append', async () => {
      const fake = new FakeCurriculum(startingCurriculum());
      await run(fake, {
        kind: 'MOVE_LECTURE',
        lectureId: 'lec_1',
        toSectionId: 'sec_b',
        toIndex: 99,
      });

      expect(fake.snapshot().sections[1].lectures.map((l) => l.id)).toEqual(['lec_3', 'lec_1']);
    });

    it('reverses the whole section order in one call', async () => {
      const fake = new FakeCurriculum(startingCurriculum());
      await run(fake, { kind: 'REORDER_SECTIONS', sectionIds: ['sec_b', 'sec_a'] });

      expect(fake.snapshot().sections.map((section) => section.id)).toEqual(['sec_b', 'sec_a']);
    });
  });

  describe('rejecting', () => {
    it.each([
      ['a section outside this course', { kind: 'RENAME_SECTION', sectionId: 'sec_x', title: 'X' }],
      ['a lecture outside this course', { kind: 'REMOVE_LECTURE', lectureId: 'lec_x' }],
      [
        'a move into a section outside this course',
        { kind: 'MOVE_LECTURE', lectureId: 'lec_1', toSectionId: 'sec_x', toIndex: 0 },
      ],
    ] as const)('refuses %s', async (_name, command) => {
      const fake = new FakeCurriculum(startingCurriculum());
      await expect(run(fake, command as CurriculumInverse)).rejects.toBeInstanceOf(
        CurriculumNodeNotFoundException,
      );
    });

    it.each([
      ['a missing id', ['sec_a']],
      ['a duplicated id', ['sec_a', 'sec_a']],
      ['an id that is not there', ['sec_a', 'sec_b', 'sec_x']],
    ])('refuses a reorder with %s', async (_name, sectionIds) => {
      const fake = new FakeCurriculum(startingCurriculum());
      await expect(run(fake, { kind: 'REORDER_SECTIONS', sectionIds })).rejects.toBeInstanceOf(
        InvalidReorderException,
      );
    });
  });

  /**
   * The property the undo stack rests on, checked for every command kind: apply it, apply
   * what it handed back, and the curriculum is byte-identical to what it was.
   *
   * This is the test that would have caught the inverse of `UPDATE_LECTURE` reverting fields
   * the original patch never touched, and the inverse of a cross-section move putting the
   * lecture back in the right section but the wrong slot.
   */
  describe('inverses', () => {
    const commands: [string, CurriculumCommand][] = [
      ['ADD_SECTION', { kind: 'ADD_SECTION', title: 'Gamma' }],
      ['RENAME_SECTION', { kind: 'RENAME_SECTION', sectionId: 'sec_a', title: 'Renamed' }],
      ['REMOVE_SECTION', { kind: 'REMOVE_SECTION', sectionId: 'sec_a' }],
      ['REORDER_SECTIONS', { kind: 'REORDER_SECTIONS', sectionIds: ['sec_b', 'sec_a'] }],
      [
        'ADD_LECTURE',
        {
          kind: 'ADD_LECTURE',
          sectionId: 'sec_a',
          lecture: {
            title: 'New',
            description: null,
            kind: 'VIDEO',
            isPreview: false,
            durationSeconds: 30,
            assetId: null,
            articleBody: null,
          },
        },
      ],
      [
        'UPDATE_LECTURE',
        { kind: 'UPDATE_LECTURE', lectureId: 'lec_1', patch: { title: 'Edited' } },
      ],
      [
        'UPDATE_LECTURE (nulling a field)',
        { kind: 'UPDATE_LECTURE', lectureId: 'lec_1', patch: { assetId: null } },
      ],
      ['REMOVE_LECTURE', { kind: 'REMOVE_LECTURE', lectureId: 'lec_1' }],
      ['REMOVE_LECTURE (last in its section)', { kind: 'REMOVE_LECTURE', lectureId: 'lec_3' }],
      [
        'MOVE_LECTURE (across sections)',
        { kind: 'MOVE_LECTURE', lectureId: 'lec_1', toSectionId: 'sec_b', toIndex: 0 },
      ],
      [
        'MOVE_LECTURE (within a section)',
        { kind: 'MOVE_LECTURE', lectureId: 'lec_2', toSectionId: 'sec_a', toIndex: 0 },
      ],
    ];

    it.each(commands)('%s round-trips', async (_name, command) => {
      const fake = new FakeCurriculum(startingCurriculum());
      const before = fake.snapshot();

      const inverse = await run(fake, command);
      expect(fake.snapshot()).not.toEqual(before);

      await run(fake, inverse);
      expect(fake.snapshot()).toEqual(before);
    });

    it('restores a removed section with its lectures and their ids', async () => {
      const fake = new FakeCurriculum(startingCurriculum());
      const inverse = await run(fake, { kind: 'REMOVE_SECTION', sectionId: 'sec_a' });
      await run(fake, inverse);

      const restored = fake.snapshot().sections.find((section) => section.id === 'sec_a');
      // The ids matter: media (task 1.6) and progress (1.10) hold lecture ids, and an undo
      // that re-keyed the rows would orphan both.
      expect(restored?.lectures.map((l) => l.id)).toEqual(['lec_1', 'lec_2']);
    });

    it('undoes a patch without touching fields it did not set', async () => {
      const fake = new FakeCurriculum(startingCurriculum());
      const inverse = await run(fake, {
        kind: 'UPDATE_LECTURE',
        lectureId: 'lec_1',
        patch: { title: 'Edited' },
      });

      expect(inverse).toEqual({
        kind: 'UPDATE_LECTURE',
        lectureId: 'lec_1',
        patch: { title: 'Lecture lec_1' },
      });
    });

    /** Two edits, undone newest-first, must walk back through both. */
    it('unwinds a stack in LIFO order', async () => {
      const fake = new FakeCurriculum(startingCurriculum());
      const start = fake.snapshot();

      const first = await run(fake, { kind: 'REMOVE_LECTURE', lectureId: 'lec_1' });
      const second = await run(fake, { kind: 'RENAME_SECTION', sectionId: 'sec_a', title: 'Zed' });

      await run(fake, second);
      await run(fake, first);

      expect(fake.snapshot()).toEqual(start);
    });
  });
});
