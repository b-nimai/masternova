import type { Category } from '@masternova/db';

export const CATEGORY_REPOSITORY = Symbol('CATEGORY_REPOSITORY');

/**
 * The category tree changes roughly never and is read on every catalog page, which makes
 * it the first thing that will sit behind a long-TTL cache — added as a Decorator over
 * this interface, with no change to any caller.
 */
export interface ICategoryRepository {
  tree(): Promise<(Category & { children: Category[] })[]>;
  findBySlug(slug: string): Promise<(Category & { children: Category[] }) | null>;
}
