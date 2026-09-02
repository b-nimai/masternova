import type { Category, Course, Prisma, PrismaClient, User } from '@masternova/db';

/**
 * Row builders for the catalog integration suite.
 *
 * **Deliberately not the 10k seed.** `packages/db/prisma/seed/catalog.seed.ts` exists to
 * make the `EXPLAIN ANALYZE` numbers in `docs/db/indexes.md` honest, and it takes minutes.
 * A test that inserts ten thousand rows per run is a test nobody runs, and a suite nobody
 * runs proves nothing. These helpers seed the smallest set that can still fail: 55 rows
 * for the pagination boundary, a handful for the specification agreement check.
 *
 * Every default is chosen so a caller only states what the test is actually about — a
 * pagination test says nothing about price, a specification test says nothing about slugs.
 */

/** Monotonic across the whole run, so a truncate between tests never re-issues a slug. */
let sequence = 0;
const unique = (): string => {
  sequence += 1;
  return `${sequence.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
};

const slugOf = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'course';

export type CourseSeed = Partial<Prisma.CourseUncheckedCreateInput>;

export async function createUser(
  prisma: PrismaClient,
  overrides: Partial<Prisma.UserUncheckedCreateInput> = {},
): Promise<User> {
  return prisma.user.create({
    data: {
      email: `seed-${unique()}@masternova.test`,
      name: 'Seeded User',
      role: 'INSTRUCTOR',
      ...overrides,
    },
  });
}

export const createInstructor = (
  prisma: PrismaClient,
  overrides: Partial<Prisma.UserUncheckedCreateInput> = {},
): Promise<User> => createUser(prisma, { role: 'INSTRUCTOR', ...overrides });

export async function createCategory(
  prisma: PrismaClient,
  overrides: Partial<Prisma.CategoryUncheckedCreateInput> = {},
): Promise<Category> {
  const name = overrides.name ?? `Category ${unique()}`;
  return prisma.category.create({
    data: { slug: `${slugOf(name)}-${unique()}`, ...overrides, name },
  });
}

/**
 * A root plus its children, which is the only shape the schema permits — two levels by
 * convention. Returned as a pair so a test can filter by the root and assert the subtree.
 */
export async function createCategoryTree(
  prisma: PrismaClient,
  rootName: string,
  childNames: readonly string[],
): Promise<{ root: Category; children: Category[] }> {
  const root = await createCategory(prisma, { name: rootName });
  const children = [];
  for (const name of childNames) {
    children.push(await createCategory(prisma, { name, parentId: root.id }));
  }
  return { root, children };
}

/**
 * `n` courses, PUBLISHED and priced at zero unless the caller says otherwise.
 *
 * `overrides` may be a function of the index, which is what the pagination test needs: it
 * seeds deliberate `publishedAt` collisions so that a sort without the `id` tiebreaker
 * produces the duplicate-or-missing row the test is hunting for.
 *
 * Sequential creates rather than `createMany` on purpose — `createMany` does not return
 * rows, and every test here compares against the exact ids it seeded.
 */
export async function seedCourses(
  prisma: PrismaClient,
  n: number,
  overrides: CourseSeed | ((index: number) => CourseSeed) = {},
): Promise<Course[]> {
  const seedAt = typeof overrides === 'function' ? overrides : () => overrides;
  const seeds = Array.from({ length: n }, (_, index) => seedAt(index));

  const fallbackInstructorId = seeds.every((seed) => seed.instructorId)
    ? null
    : (await createInstructor(prisma)).id;

  const courses: Course[] = [];
  for (const [index, seed] of seeds.entries()) {
    const title = seed.title ?? `Seeded Course ${index}`;
    courses.push(
      await prisma.course.create({
        data: {
          slug: `${slugOf(title)}-${unique()}`,
          description: 'Seeded for the catalog integration suite.',
          language: 'en',
          level: 'ALL_LEVELS',
          status: 'PUBLISHED',
          publishedAt: new Date(),
          instructorId: fallbackInstructorId as string,
          ...seed,
          title,
        },
      }),
    );
  }
  return courses;
}

export interface StructureOptions {
  readonly instructorId: string;
  readonly sections: number;
  readonly lecturesPerSection: number;
  readonly course?: CourseSeed;
}

/**
 * One course with a real section/lecture graph — what the duplicate and detail tests need.
 *
 * Positions step by 10, matching the schema's note about inserting between two rows with
 * one UPDATE. `assetId` is deterministic (`asset-s0-l1`) because the Prototype test asserts
 * the copy *shares* these values rather than regenerating them.
 */
export async function seedCourseWithStructure(
  prisma: PrismaClient,
  options: StructureOptions,
): Promise<Course> {
  const [course] = await seedCourses(prisma, 1, {
    instructorId: options.instructorId,
    status: 'DRAFT',
    publishedAt: null,
    lectureCount: options.sections * options.lecturesPerSection,
    ...options.course,
  });

  for (let s = 0; s < options.sections; s += 1) {
    await prisma.section.create({
      data: {
        courseId: course.id,
        title: `Section ${s + 1}`,
        position: (s + 1) * 10,
        lectures: {
          create: Array.from({ length: options.lecturesPerSection }, (_, l) => ({
            title: `Lecture ${s + 1}.${l + 1}`,
            kind: 'VIDEO' as const,
            position: (l + 1) * 10,
            isPreview: l === 0,
            durationSeconds: 300 + l,
            assetId: `asset-s${s}-l${l}`,
          })),
        },
      },
    });
  }

  return course;
}

/**
 * Only the tables this suite owns.
 *
 * Courses go before users because `Course.instructorId` is `onDelete: Restrict` — the
 * database is what enforces "a course never loses its instructor", so the order matters.
 * Sections and lectures cascade from the course and need no statement of their own.
 */
export async function resetCatalog(prisma: PrismaClient): Promise<void> {
  // `CourseEdit` cascades from the course, so it needs no statement of its own.
  await prisma.course.deleteMany();
  await prisma.category.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.outboxMessage.deleteMany();
  await prisma.user.deleteMany();
}

/**
 * A course that passes every publish requirement.
 *
 * It exists because the gate has ten rules and a test about *transitions* should not be a
 * test about remembering all ten — a missing thumbnail failing a lifecycle test tells you
 * nothing you wanted to know. Tests that are about the gate build their own broken course.
 */
export async function seedPublishableCourse(
  prisma: PrismaClient,
  instructorId: string,
  overrides: CourseSeed = {},
): Promise<Course> {
  const category = await createCategory(prisma, { name: 'DevOps' });

  const course = await seedCourseWithStructure(prisma, {
    instructorId,
    sections: 1,
    lecturesPerSection: 2,
    course: {
      status: 'DRAFT',
      publishedAt: null,
      subtitle: 'Run it in production without crying',
      description: 'x'.repeat(200),
      categoryId: category.id,
      thumbnailKey: 'thumbs/publishable.png',
      priceSetAt: new Date(),
      ...overrides,
    },
  });

  return course;
}
