import { Module } from '@nestjs/common';
import { CoursesController } from './courses.controller';
import { InstructorCoursesController } from './instructor-courses.controller';
import { CategoriesController } from './categories.controller';
import { CourseCatalogService } from './course-catalog.service';
import { CourseEditingService } from './course-editing.service';
import { CourseDuplicationService } from './course-duplication.service';
import { CategoryService } from './category.service';
import { PrismaCourseRepository } from './repositories/course.repository';
import { COURSE_READER } from './repositories/course.reader.interface';
import { COURSE_WRITER } from './repositories/course.writer.interface';
import { CATEGORY_REPOSITORY } from './repositories/category.repository.interface';
import { PrismaCategoryRepository } from './repositories/category.repository';

/**
 * The `catalog` bounded context: what a course *is*, and how it is found.
 *
 * It does not decide who may watch a lecture — that depends on purchases and refund
 * windows and belongs to the entitlement engine (task 1.8). It does not decide what a
 * course *should* cost either; coupons and tax are `PricingService` in commerce (1.9).
 * Catalog stores a number and a publish state, and answers questions about them.
 */
@Module({
  controllers: [CoursesController, InstructorCoursesController, CategoriesController],
  providers: [
    CourseCatalogService,
    CourseEditingService,
    CourseDuplicationService,
    CategoryService,

    /**
     * One repository class, two role-shaped tokens, bound with `useExisting`.
     *
     * `useClass` twice would build two instances of the same repository — harmless today
     * and wrong the moment a caching Decorator wraps the reader, because half the callers
     * would be talking to an uncached copy. `useExisting` aliases both tokens onto the one
     * provider, so the split is about what a client can see (§1 I), not about how many
     * objects exist.
     */
    PrismaCourseRepository,
    { provide: COURSE_READER, useExisting: PrismaCourseRepository },
    { provide: COURSE_WRITER, useExisting: PrismaCourseRepository },

    { provide: CATEGORY_REPOSITORY, useClass: PrismaCategoryRepository },
  ],
  exports: [CourseCatalogService],
})
export class CatalogModule {}
