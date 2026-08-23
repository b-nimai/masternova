import { Injectable } from '@nestjs/common';
import type { Category } from '@masternova/db';
import { PrismaService } from '../../../prisma/prisma.service';
import type { ICategoryRepository } from './category.repository.interface';

@Injectable()
export class PrismaCategoryRepository implements ICategoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Roots with their children — two levels, so one query with one include is enough. */
  tree(): Promise<(Category & { children: Category[] })[]> {
    return this.prisma.category.findMany({
      where: { parentId: null },
      orderBy: { name: 'asc' },
      include: { children: { orderBy: { name: 'asc' } } },
    });
  }

  findBySlug(slug: string): Promise<(Category & { children: Category[] }) | null> {
    return this.prisma.category.findUnique({ where: { slug }, include: { children: true } });
  }
}
