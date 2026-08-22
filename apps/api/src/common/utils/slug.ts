import { randomInt } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const SUFFIX_LENGTH = 8;
const MAX_BASE_LENGTH = 40;

/**
 * Random suffix from node's crypto. `randomInt` rejection-samples internally, so every
 * character is uniformly distributed — a naive `randomBytes(n)[i] % 36` would be biased
 * toward the first four letters and quietly cost entropy.
 *
 * This replaced nanoid: v5 is ESM-only and cannot be required from the CommonJS build
 * NestJS needs, which broke the unit test. Eight characters of stdlib is not worth a
 * dependency plus a dual-module Jest configuration.
 */
function randomSuffix(): string {
  let out = '';
  for (let i = 0; i < SUFFIX_LENGTH; i += 1) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

/** A URL-safe, collision-resistant slug from a title: "My Course" -> "my-course-a1b2c3d4". */
export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_BASE_LENGTH)
    .replace(/-+$/g, '');
  return `${base || 'untitled'}-${randomSuffix()}`;
}
