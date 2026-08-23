import { Inject, Injectable } from '@nestjs/common';
import type { CategoryTree } from '@masternova/shared';
import {
  CATEGORY_REPOSITORY,
  type ICategoryRepository,
} from './repositories/category.repository.interface';

/** Two levels, flattened into the shape the browse sidebar renders. */
@Injectable()
export class CategoryService {
  constructor(@Inject(CATEGORY_REPOSITORY) private readonly categories: ICategoryRepository) {}

  async tree(): Promise<CategoryTree> {
    const roots = await this.categories.tree();
    return {
      categories: roots.map((root) => ({
        id: root.id,
        slug: root.slug,
        name: root.name,
        children: root.children.map((child) => ({
          id: child.id,
          slug: child.slug,
          name: child.name,
        })),
      })),
    };
  }
}
