/**
 * Catalog seed — 10,000 courses shaped like a real marketplace.
 *
 * The force: task 1.4's index work is only credible if the `EXPLAIN ANALYZE` numbers in
 * `docs/db/indexes.md` came off a table whose *distribution* is realistic. A seed where
 * every course is PUBLISHED and evenly spread across categories flatters every index,
 * because every predicate has the same selectivity and the planner never faces an
 * interesting decision. Skew is the entire point of this file:
 *
 *   - status is 78/15/4/3, so `status='PUBLISHED'` is a weak filter, not a free win;
 *   - categories follow a Zipf law, so the *same* browse query is a cheap index scan for
 *     a cold category and an expensive one for a hot category — which is the single most
 *     instructive line in the document;
 *   - instructors follow a milder Zipf, so the dashboard query has one instructor with
 *     ~180 courses and a median instructor with ~30;
 *   - titles are drawn from a tech corpus sized so that `title ILIKE '%kubernetes%'`
 *     matches a plausible ~125 rows rather than 0 or 9,000. A substring search that
 *     matches nothing proves nothing about a trigram index.
 *
 * DETERMINISM. Everything random here comes from `mulberry32` seeded with `SEED` below.
 * The same seed produces byte-identical rows, which is what makes the latency numbers in
 * `docs/db/indexes.md` reproducible — by a reviewer, and by the author in six weeks when
 * he no longer remembers what the database looked like. Never make this depend on
 * `Math.random`, `Date.now`, or `cuid()`.
 *
 * WHY ONLY 500 COURSES GET REAL STRUCTURE. Sections and lectures for all 10,000 courses
 * would be ~480k rows and several minutes of insert time, and would measure nothing extra:
 * the catalog *list* query never touches sections, and the *detail* query touches exactly
 * one course's sections and their lectures. 500 real structures (3,000 sections, 24,000
 * lectures) measure that fan-out honestly while keeping the seed under two minutes. The
 * other 9,500 courses still carry `lectureCount` and `totalDurationSeconds`, because those
 * are denormalized rollups the card renders and the list query *does* read.
 *
 * CONFIG RULE. CLAUDE.md §4 forbids reading `process.env` outside `src/config/`. That rule
 * is about application code, where an unvalidated env read is a runtime landmine behind a
 * dependency injection boundary. This is a standalone script with no Nest container and no
 * config module to inject; the Prisma CLI reads `DATABASE_URL` from `packages/db/.env` the
 * same way. Reading it here — and failing loudly if it is missing — is the correct shape.
 *
 * Run: `pnpm -F @masternova/db run seed:catalog`
 */

import { PrismaClient, Prisma } from '@prisma/client';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Run from packages/db (which has a .env), or export it:\n' +
      "  export DATABASE_URL='postgresql://masternova:masternova@localhost:5432/masternova?schema=public'",
  );
}

const prisma = new PrismaClient();

// ─── deterministic randomness ────────────────────────────────────────────────

/** Change this and every number in docs/db/indexes.md becomes a lie. */
const SEED = 0x4d41_5354; // "MAST"

/** mulberry32 — 32-bit PRNG, ~1 line, good enough for data shaping and fully portable. */
function mulberry32(a: number): () => number {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);

const randInt = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));

const choice = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

/** Weighted pick over a parallel weights array. Weights need not sum to 1. */
function weightedIndex(weights: readonly number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/**
 * Ids are generated here rather than left to Prisma's `cuid()` default for two reasons:
 * `createMany` does not return generated ids, so linking 24,000 lectures to their sections
 * would need a read-back; and `cuid()` is time-seeded, which would make the ids — and
 * therefore the `ORDER BY id DESC` tiebreak and the keyset cursor — differ between runs.
 * Shape matches cuid (leading 'c', 25 chars) so nothing downstream can tell the difference.
 */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
function id(): string {
  let s = 'c';
  for (let i = 0; i < 24; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

// ─── corpora ─────────────────────────────────────────────────────────────────

/**
 * ~80 terms, near-uniform on purpose. One term is drawn per title, so each appears in
 * roughly 10,000/80 ≈ 125 titles — which is the whole design goal for `%kubernetes%`:
 * a match count a human would believe. No other term contains "kubernetes" as a substring,
 * so the ILIKE count is exactly the count of titles built from this one term.
 */
const TECH_TERMS = [
  'Kubernetes',
  'Docker',
  'Terraform',
  'Ansible',
  'Prometheus',
  'Grafana',
  'Istio',
  'PostgreSQL',
  'Redis',
  'MongoDB',
  'Cassandra',
  'ClickHouse',
  'Elasticsearch',
  'Kafka',
  'RabbitMQ',
  'gRPC',
  'GraphQL',
  'REST API Design',
  'System Design',
  'Microservices',
  'Event Sourcing',
  'Domain-Driven Design',
  'Clean Architecture',
  'Design Patterns',
  'TypeScript',
  'JavaScript',
  'React',
  'Next.js',
  'Vue',
  'Svelte',
  'Angular',
  'Node.js',
  'NestJS',
  'Express',
  'Deno',
  'Bun',
  'Python',
  'Django',
  'FastAPI',
  'Flask',
  'Go',
  'Rust',
  'Java',
  'Spring Boot',
  'Kotlin',
  'Swift',
  'C++',
  'C#',
  '.NET',
  'Ruby on Rails',
  'PHP',
  'Laravel',
  'Elixir',
  'Scala',
  'Haskell',
  'AWS',
  'Azure',
  'Google Cloud',
  'Serverless',
  'CI/CD',
  'GitHub Actions',
  'GitOps',
  'ArgoCD',
  'Linux',
  'Bash Scripting',
  'Networking',
  'Observability',
  'Site Reliability Engineering',
  'Load Testing',
  'Web Security',
  'Penetration Testing',
  'Cryptography',
  'Machine Learning',
  'Deep Learning',
  'PyTorch',
  'TensorFlow',
  'Large Language Models',
  'Data Engineering',
  'Apache Spark',
  'dbt',
  'Tableau',
] as const;

const TITLE_TEMPLATES = [
  (t: string) => `The Complete ${t} Bootcamp`,
  (t: string) => `${t} for Beginners`,
  (t: string) => `Mastering ${t}`,
  (t: string) => `${t}: From Zero to Production`,
  (t: string) => `Practical ${t}`,
  (t: string) => `${t} in Depth`,
  (t: string) => `Hands-On ${t}`,
  (t: string) => `${t} Crash Course`,
  (t: string) => `Advanced ${t} Patterns`,
  (t: string) => `${t} for Working Engineers`,
  (t: string) => `Build Real Projects with ${t}`,
  (t: string) => `${t} — The Missing Manual`,
] as const;

const SUBTITLE_CLAUSES = [
  'Ship something real in a weekend, not a semester',
  'Everything the docs assume you already know',
  'Taught by building, debugging, and breaking things on purpose',
  'A production mindset from the very first lesson',
  'Short lessons, real repositories, no filler',
  'The interview questions, and the reasons behind the answers',
  'From first principles to a deployable system',
  'For engineers who are tired of tutorials that stop at hello world',
] as const;

const DESCRIPTION_OPENERS = [
  'This course takes you from the fundamentals through to a system you would be comfortable running in production.',
  'Every module ends with a working artefact you can read, run, and put in a repository.',
  'We start with the mental model, then write the code, then break it and watch what happens.',
  'Nothing here is theoretical for its own sake: each concept arrives because a real problem demanded it.',
] as const;

const DESCRIPTION_BODIES = [
  'You will learn how the pieces fit together, why the obvious approach fails at scale, and what the alternatives cost.',
  'We cover the happy path quickly and then spend real time on the failure modes, because that is where the job actually is.',
  'Along the way we build a small but honest project, refactor it twice, and instrument it so you can see what it is doing.',
  'The exercises are designed so that a wrong answer teaches you something specific rather than leaving you stuck.',
] as const;

const DESCRIPTION_CLOSERS = [
  'By the end you will be able to explain the design on a whiteboard, which is the real test.',
  'Prerequisites are modest: comfort with a terminal and a willingness to read error messages.',
  'Lifetime access, source code for every lesson, and a changelog when the ecosystem moves.',
  'Suitable as a first serious course in the subject or as a structured refresher.',
] as const;

const SECTION_TITLES = [
  'Getting Set Up',
  'Core Concepts',
  'The Data Model',
  'Building the First Feature',
  'Testing What Matters',
  'Going to Production',
  'Observability and Debugging',
  'Performance and Cost',
  'Security Basics',
  'Where to Go Next',
] as const;

const LECTURE_TITLES = [
  'Why this exists',
  'Installing the toolchain',
  'Your first run',
  'Reading the output',
  'The mental model',
  'A worked example',
  'Common mistakes',
  'Under the hood',
  'Wiring it together',
  'Handling failure',
  'Writing the test',
  'Refactoring safely',
  'Measuring it',
  'Shipping it',
  'Recap and exercises',
] as const;

const TOPIC_TAGS = [
  'backend',
  'frontend',
  'devops',
  'sre',
  'cloud',
  'databases',
  'security',
  'testing',
  'architecture',
  'interview-prep',
  'kubernetes',
  'ai',
  'data',
  'mobile',
  'career',
] as const;

const CATEGORY_TREE: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    'Web Development',
    ['Frontend Frameworks', 'Backend Development', 'Full Stack', 'Web Performance', 'Browser APIs'],
  ],
  [
    'Cloud & DevOps',
    [
      'Kubernetes & Containers',
      'Infrastructure as Code',
      'CI/CD',
      'Cloud Platforms',
      'Observability',
    ],
  ],
  [
    'Data Engineering',
    ['Streaming', 'Warehousing', 'ETL & Orchestration', 'Analytics Engineering', 'Data Modelling'],
  ],
  [
    'AI & Machine Learning',
    ['Deep Learning', 'LLMs & RAG', 'Classical ML', 'MLOps', 'Computer Vision'],
  ],
  ['Programming Languages', ['TypeScript', 'Python', 'Go', 'Rust', 'JVM Languages']],
  [
    'System Design',
    ['Distributed Systems', 'Scalability', 'Design Patterns', 'Interview Prep', 'Domain Modelling'],
  ],
  ['Databases', ['Relational', 'NoSQL', 'Query Performance', 'Search Engines', 'Caching']],
  [
    'Security',
    [
      'Application Security',
      'Cryptography',
      'Offensive Security',
      'Identity & Access',
      'Compliance',
    ],
  ],
  [
    'Mobile Development',
    ['iOS', 'Android', 'Cross Platform', 'Mobile Performance', 'App Store Craft'],
  ],
  [
    'Career & Interview',
    ['Coding Interviews', 'Behavioural', 'Resume & Portfolio', 'Negotiation', 'Freelancing'],
  ],
  [
    'Product & Design',
    ['UI Fundamentals', 'UX Research', 'Design Systems', 'Prototyping', 'Accessibility'],
  ],
  [
    'Business & Leadership',
    [
      'Engineering Management',
      'Agile Practice',
      'Startups',
      'Communication',
      'Finance for Engineers',
    ],
  ],
];

// ─── distributions ───────────────────────────────────────────────────────────

const COURSE_COUNT = 10_000;
const INSTRUCTOR_COUNT = 200;
const STRUCTURED_COURSES = 500;
const SECTIONS_PER_COURSE = 6;
const LECTURES_PER_SECTION = 8;
const CHUNK = 1_000;
/** Positions are spaced so an insert between two rows is one UPDATE, not a renumber. */
const POSITION_GAP = 10;

const SEED_EMAIL_DOMAIN = 'seed.masternova.dev';

/**
 * Zipf with s = 1.0 over 60 subcategories. This exponent is chosen, not default: it puts
 * ~39% of the catalog in the top 3 subcategories (~2,100 / ~1,050 / ~700 courses) and
 * leaves the coldest at ~0.36% (~36 courses). That two-orders-of-magnitude spread is what
 * makes the *same* browse SQL a different plan depending on which category you pass, which
 * is the point of measuring it twice.
 */
const CATEGORY_ZIPF_S = 1.0;
/** Milder skew: one instructor with ~180 courses, a median instructor with ~30. */
const INSTRUCTOR_ZIPF_S = 0.3;

const zipfWeights = (n: number, s: number): number[] =>
  Array.from({ length: n }, (_, i) => 1 / Math.pow(i + 1, s));

/** 78 / 15 / 4 / 3 — a real catalog is mostly published, but far from entirely. */
const STATUS_VALUES = ['PUBLISHED', 'DRAFT', 'IN_REVIEW', 'ARCHIVED'] as const;
const STATUS_WEIGHTS = [78, 15, 4, 3];

const LEVEL_VALUES = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'ALL_LEVELS'] as const;
const LEVEL_WEIGHTS = [35, 28, 17, 20];

/** A realistic ladder, not a uniform random price. Free courses exist and are ~8%. */
const PRICE_LADDER = [0, 49_900, 99_900, 149_900, 199_900, 349_900];
const PRICE_WEIGHTS = [8, 22, 30, 20, 13, 7];

const LANGUAGE_VALUES = ['en', 'hi', 'es', 'pt'] as const;
const LANGUAGE_WEIGHTS = [82, 9, 6, 3];

const MONTHS_OF_HISTORY = 36;

// ─── helpers ─────────────────────────────────────────────────────────────────

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/\+/g, 'plus')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** A deterministic instant `monthsAgo` months back, jittered within the month. */
function pastDate(monthsAgo: number, now: number): Date {
  const day = randInt(0, 27);
  const ms = now - monthsAgo * 30 * 86_400_000 - day * 86_400_000 - randInt(0, 86_399) * 1000;
  return new Date(ms);
}

async function inChunks<T>(rows: T[], write: (batch: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await write(rows.slice(i, i + CHUNK));
  }
}

// ─── the seed ────────────────────────────────────────────────────────────────

/**
 * Idempotent-ish: clears exactly what this script owns and nothing else. Users are deleted
 * only when they carry the seed email domain AND the INSTRUCTOR role, so a hand-made admin
 * account or another module's fixtures survive a re-run. Courses go before categories and
 * before users because both of those foreign keys are RESTRICT — and RESTRICT is checked
 * per row, so it cannot be satisfied by deleting everything in one statement.
 */
async function clearCatalog(): Promise<void> {
  await prisma.lecture.deleteMany({});
  await prisma.section.deleteMany({});
  await prisma.course.deleteMany({});
  // Children first: Category.parentId is RESTRICT, so a single DELETE would fail.
  await prisma.category.deleteMany({ where: { parentId: { not: null } } });
  await prisma.category.deleteMany({});
  await prisma.user.deleteMany({
    where: { role: 'INSTRUCTOR', email: { endsWith: `@${SEED_EMAIL_DOMAIN}` } },
  });
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const now = Date.parse('2026-08-22T12:00:00.000Z');

  console.log(`catalog seed · PRNG seed 0x${SEED.toString(16)} · target ${COURSE_COUNT} courses`);

  await clearCatalog();
  console.log(`  cleared catalog tables (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);

  // ── instructors ────────────────────────────────────────────────────────────
  const instructorIds: string[] = [];
  const instructors = Array.from({ length: INSTRUCTOR_COUNT }, (_, i) => {
    const uid = id();
    instructorIds.push(uid);
    const n = String(i + 1).padStart(3, '0');
    const createdAt = pastDate(randInt(0, MONTHS_OF_HISTORY + 6), now);
    return {
      id: uid,
      email: `instructor-${n}@${SEED_EMAIL_DOMAIN}`,
      name: `Instructor ${n}`,
      // No password hash: these accounts exist to own courses, not to sign in. A null
      // hash is exactly what identity already treats as "not a password account".
      passwordHash: null,
      role: 'INSTRUCTOR' as const,
      emailVerified: createdAt,
      createdAt,
      updatedAt: createdAt,
    };
  });
  await inChunks(instructors, (batch) => prisma.user.createMany({ data: batch }));

  // ── categories ─────────────────────────────────────────────────────────────
  const rootRows: Prisma.CategoryCreateManyInput[] = [];
  const childRows: Prisma.CategoryCreateManyInput[] = [];
  const subcategoryIds: string[] = [];
  const subcategoryNames = new Map<string, string>();

  for (const [rootName, children] of CATEGORY_TREE) {
    const rootId = id();
    rootRows.push({
      id: rootId,
      slug: slugify(rootName),
      name: rootName,
      parentId: null,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    for (const childName of children) {
      const childId = id();
      subcategoryIds.push(childId);
      subcategoryNames.set(childId, `${rootName} › ${childName}`);
      childRows.push({
        id: childId,
        slug: slugify(`${rootName}-${childName}`),
        name: childName,
        parentId: rootId,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      });
    }
  }
  await prisma.category.createMany({ data: rootRows });
  await prisma.category.createMany({ data: childRows });

  /**
   * The Zipf ranks are shuffled across the 60 subcategories once, deterministically, so the
   * hot categories are not simply the first three in the tree. Otherwise "the hot category"
   * and "the first category" would be the same thing and the measurement would look rigged.
   */
  const rankedSubcategories = [...subcategoryIds];
  for (let i = rankedSubcategories.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rankedSubcategories[i], rankedSubcategories[j]] = [
      rankedSubcategories[j]!,
      rankedSubcategories[i]!,
    ];
  }
  const categoryWeights = zipfWeights(rankedSubcategories.length, CATEGORY_ZIPF_S);
  const instructorWeights = zipfWeights(INSTRUCTOR_COUNT, INSTRUCTOR_ZIPF_S);
  const rankedInstructors = [...instructorIds];
  for (let i = rankedInstructors.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rankedInstructors[i], rankedInstructors[j]] = [rankedInstructors[j]!, rankedInstructors[i]!];
  }

  // ── courses ────────────────────────────────────────────────────────────────
  const courseRows: Prisma.CourseCreateManyInput[] = [];
  const usedSlugs = new Set<string>();
  /** Courses that will receive real sections and lectures, chosen below. */
  const structured: Array<{ id: string }> = [];

  for (let i = 0; i < COURSE_COUNT; i++) {
    const courseId = id();
    const term = choice(TECH_TERMS);
    const title = choice(TITLE_TEMPLATES)(term);

    let slug = slugify(title);
    if (usedSlugs.has(slug)) {
      // Real slugs get a random suffix at creation and never change on rename. Same rule
      // here, so the unique index is exercised the way production will exercise it.
      slug = `${slug}-${id().slice(1, 7)}`;
    }
    usedSlugs.add(slug);

    const status = STATUS_VALUES[weightedIndex(STATUS_WEIGHTS)]!;
    const level = LEVEL_VALUES[weightedIndex(LEVEL_WEIGHTS)]!;
    const priceMinor = PRICE_LADDER[weightedIndex(PRICE_WEIGHTS)]!;

    // Only ~45% of paid courses have ever been discounted; the rest have no "was" price,
    // which is a null and not a zero (a zero would be a lie the UI has to special-case).
    const listPriceMinor =
      priceMinor > 0 && rand() < 0.45
        ? PRICE_LADDER[
            Math.min(PRICE_LADDER.length - 1, PRICE_LADDER.indexOf(priceMinor) + randInt(1, 2))
          ]!
        : null;

    const createdAt = pastDate(randInt(0, MONTHS_OF_HISTORY), now);
    const published = status === 'PUBLISHED' || status === 'ARCHIVED';
    // publishedAt is set on first publish and kept across unpublish, so ARCHIVED keeps it.
    const publishedAt = published
      ? new Date(Math.min(now, createdAt.getTime() + randInt(1, 60) * 86_400_000))
      : null;
    const updatedAt = new Date(
      Math.min(now, (publishedAt ?? createdAt).getTime() + randInt(0, 240) * 86_400_000),
    );

    // Ratings cluster 3.8–4.8 with a thin tail down to 2.4 — the shape of every real
    // marketplace, where a bad course stops selling before it accumulates many reviews.
    const ratingAverage = rand() < 0.12 ? 2.4 + rand() * 1.4 : 3.8 + rand() * 1.0;
    // Long-tailed review counts: most courses have a handful, a few have thousands.
    const hasRatings = published && rand() < 0.86;
    const ratingCount = hasRatings ? Math.floor(Math.exp(rand() * Math.log(4_000))) : 0;
    const roundedAverage = ratingCount > 0 ? Math.round(ratingAverage * 100) / 100 : 0;
    const ratingSum = Math.round(roundedAverage * ratingCount);

    const lectureCount = randInt(12, 180);
    const totalDurationSeconds = lectureCount * randInt(240, 900);

    const topicCount = randInt(1, 3);
    const topics: string[] = [];
    for (let t = 0; t < topicCount; t++) {
      const tag = choice(TOPIC_TAGS);
      if (!topics.includes(tag)) topics.push(tag);
    }

    courseRows.push({
      id: courseId,
      slug,
      title,
      subtitle: choice(SUBTITLE_CLAUSES),
      description: `${choice(DESCRIPTION_OPENERS)} ${choice(DESCRIPTION_BODIES)} ${choice(DESCRIPTION_CLOSERS)}`,
      language: LANGUAGE_VALUES[weightedIndex(LANGUAGE_WEIGHTS)]!,
      level,
      status,
      publishedAt,
      priceMinor,
      listPriceMinor,
      currency: rand() < 0.88 ? 'INR' : 'USD',
      thumbnailKey: `catalog/thumbnails/${courseId}.jpg`,
      promoVideoAssetId: rand() < 0.35 ? id() : null,
      instructorId: rankedInstructors[weightedIndex(instructorWeights)]!,
      categoryId: rankedSubcategories[weightedIndex(categoryWeights)]!,
      topics,
      ratingCount,
      ratingSum,
      ratingAverage: new Prisma.Decimal(roundedAverage.toFixed(2)),
      enrollmentCount: ratingCount * randInt(8, 40),
      lectureCount,
      totalDurationSeconds,
      version: randInt(0, 40),
      createdAt,
      updatedAt,
    });
  }

  await inChunks(courseRows, (batch) => prisma.course.createMany({ data: batch }));
  console.log(
    `  inserted ${courseRows.length} courses (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`,
  );

  // ── structure for a 500-course sample ──────────────────────────────────────
  // Every Nth PUBLISHED course, so the sample is spread evenly across the whole table
  // rather than clustered at one end of the heap — a detail query that only ever hits
  // freshly-written pages measures the buffer cache, not the index.
  const publishedRows = courseRows.filter((r) => r.status === 'PUBLISHED');
  const stride = Math.floor(publishedRows.length / STRUCTURED_COURSES);
  for (let i = 0; structured.length < STRUCTURED_COURSES && i < publishedRows.length; i += stride) {
    structured.push({ id: publishedRows[i]!.id as string });
  }

  const sectionRows: Prisma.SectionCreateManyInput[] = [];
  const lectureRows: Prisma.LectureCreateManyInput[] = [];
  const realCounts = new Map<string, { lectures: number; seconds: number }>();

  for (const course of structured) {
    let lectures = 0;
    let seconds = 0;
    for (let s = 0; s < SECTIONS_PER_COURSE; s++) {
      const sectionId = id();
      sectionRows.push({
        id: sectionId,
        courseId: course.id,
        title: SECTION_TITLES[s % SECTION_TITLES.length]!,
        position: (s + 1) * POSITION_GAP,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      });
      for (let l = 0; l < LECTURES_PER_SECTION; l++) {
        const durationSeconds = randInt(180, 1_800);
        const kind = rand() < 0.08 ? ('ARTICLE' as const) : ('VIDEO' as const);
        lectures += 1;
        seconds += durationSeconds;
        lectureRows.push({
          id: id(),
          sectionId,
          title: LECTURE_TITLES[(s * LECTURES_PER_SECTION + l) % LECTURE_TITLES.length]!,
          description: null,
          kind,
          position: (l + 1) * POSITION_GAP,
          // The free preview: the opening lecture of the opening section, plus a scattering
          // elsewhere. This is the flag the entitlement engine reads in task 1.8.
          isPreview: (s === 0 && l === 0) || rand() < 0.04,
          durationSeconds: kind === 'ARTICLE' ? 0 : durationSeconds,
          assetId: kind === 'VIDEO' ? id() : null,
          articleBody: kind === 'ARTICLE' ? choice(DESCRIPTION_BODIES) : null,
          createdAt: new Date(now),
          updatedAt: new Date(now),
        });
      }
    }
    realCounts.set(course.id, { lectures, seconds });
  }

  await inChunks(sectionRows, (batch) => prisma.section.createMany({ data: batch }));
  await inChunks(lectureRows, (batch) => prisma.lecture.createMany({ data: batch }));

  // The rollups must agree with the rows that now exist, or the seed has shipped the exact
  // drift task 1.14 owes a reconciliation job for.
  for (const [courseId, counts] of realCounts) {
    await prisma.course.update({
      where: { id: courseId },
      data: { lectureCount: counts.lectures, totalDurationSeconds: counts.seconds },
    });
  }

  console.log(
    `  inserted ${sectionRows.length} sections, ${lectureRows.length} lectures ` +
      `for ${structured.length} courses (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`,
  );

  // ── statistics ─────────────────────────────────────────────────────────────
  // Without this the first EXPLAIN runs against default estimates and reports a plan the
  // planner would never choose again once autovacuum caught up. A "before" measured on
  // stale statistics is not a before, it is noise.
  await prisma.$executeRawUnsafe('ANALYZE');

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`  ANALYZE done · total ${elapsed}s`);
  await report();
}

/** Prints the facts the measurement protocol in docs/db/indexes.md needs as inputs. */
async function report(): Promise<void> {
  const byStatus = await prisma.course.groupBy({ by: ['status'], _count: { _all: true } });
  console.log('\nstatus mix');
  for (const r of byStatus.sort((a, b) => b._count._all - a._count._all)) {
    console.log(`  ${r.status.padEnd(10)} ${String(r._count._all).padStart(5)}`);
  }

  const byCategory = await prisma.$queryRaw<
    Array<{ slug: string; total: bigint; published: bigint }>
  >`
    SELECT c.slug,
           COUNT(*)                                             AS total,
           COUNT(*) FILTER (WHERE co.status = 'PUBLISHED')       AS published
    FROM "Course" co JOIN "Category" c ON c.id = co."categoryId"
    GROUP BY c.slug ORDER BY total DESC`;
  console.log('\ncategory skew (top 3 and bottom 3)');
  for (const r of [...byCategory.slice(0, 3), ...byCategory.slice(-3)]) {
    console.log(
      `  ${r.slug.padEnd(44)} ${String(r.total).padStart(5)} total  ${String(r.published).padStart(5)} published`,
    );
  }
  const top3 = byCategory.slice(0, 3).reduce((a, r) => a + Number(r.total), 0);
  console.log(`  top 3 hold ${((top3 / 10_000) * 100).toFixed(1)}% of the catalog`);

  const kubernetes = await prisma.course.count({
    where: { title: { contains: 'kubernetes', mode: 'insensitive' } },
  });
  console.log(`\ntitle ILIKE '%kubernetes%' matches ${kubernetes} courses`);

  const topInstructor = await prisma.$queryRaw<Array<{ id: string; email: string; n: bigint }>>`
    SELECT u.id, u.email, COUNT(*) AS n
    FROM "Course" c JOIN "User" u ON u.id = c."instructorId"
    GROUP BY u.id, u.email ORDER BY n DESC LIMIT 1`;
  console.log(`busiest instructor ${topInstructor[0]?.email} owns ${topInstructor[0]?.n} courses`);

  const cursor = await prisma.course.findMany({
    where: { status: 'PUBLISHED' },
    orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
    skip: 999,
    take: 1,
    select: { id: true, publishedAt: true, slug: true },
  });
  console.log(
    `keyset cursor at row 1000: publishedAt=${cursor[0]?.publishedAt?.toISOString()} id=${cursor[0]?.id}`,
  );

  const detail = await prisma.section.findFirst({
    orderBy: { courseId: 'asc' },
    select: { course: { select: { slug: true } } },
  });
  console.log(`a course with real structure: ${detail?.course.slug}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
