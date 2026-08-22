import { customAlphabet } from 'nanoid';

const slugId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8);

/** A URL-safe, collision-resistant slug from a title: "My Demo" -> "my-demo-a1b2c3d4". */
export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'video'}-${slugId()}`;
}
