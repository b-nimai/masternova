import { Controller, Get } from '@nestjs/common';
import type { CategoryTree } from '@masternova/shared';
import { Public } from '../../common/decorators/public.decorator';
import { CategoryService } from './category.service';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoryService) {}

  @Public()
  @Get()
  tree(): Promise<CategoryTree> {
    return this.categories.tree();
  }
}
