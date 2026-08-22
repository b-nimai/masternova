import { slugify } from './slug';

/**
 * Pure function, no database — exactly the shape CLAUDE.md §6 asks unit tests to take.
 * The interesting property is the last one: the suffix is what makes two courses with
 * the same title not collide on a unique index.
 */
describe('slugify', () => {
  const SUFFIX = /-[0-9a-z]{8}$/;

  it('lowercases and hyphenates a normal title', () => {
    expect(slugify('My First Course')).toMatch(/^my-first-course-[0-9a-z]{8}$/);
  });

  it('collapses runs of non-alphanumerics into a single hyphen', () => {
    expect(slugify('Node.js  &  TypeScript!!')).toMatch(/^node-js-typescript-[0-9a-z]{8}$/);
  });

  it('trims leading and trailing hyphens from the base', () => {
    const slug = slugify('  ...Advanced Rust...  ');
    expect(slug.startsWith('-')).toBe(false);
    expect(slug).toMatch(/^advanced-rust-[0-9a-z]{8}$/);
  });

  it('truncates the base to 40 characters', () => {
    const slug = slugify('a'.repeat(120));
    const base = slug.replace(SUFFIX, '');
    expect(base).toHaveLength(40);
  });

  it('falls back to "untitled" when the title has no usable characters', () => {
    expect(slugify('!!!')).toMatch(/^untitled-[0-9a-z]{8}$/);
    expect(slugify('')).toMatch(/^untitled-[0-9a-z]{8}$/);
  });

  it('always appends an 8-character suffix', () => {
    expect(slugify('Anything')).toMatch(SUFFIX);
  });

  it('produces distinct slugs for the same title — the point of the suffix', () => {
    const slugs = new Set(Array.from({ length: 500 }, () => slugify('Duplicate Title')));
    expect(slugs.size).toBe(500);
  });
});
