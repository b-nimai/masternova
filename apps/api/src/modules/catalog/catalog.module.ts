import { Module } from '@nestjs/common';
import { CoursesController } from './courses.controller';
import { InstructorCoursesController } from './instructor-courses.controller';
import { CategoriesController } from './categories.controller';
import { CourseLifecycleController } from './lifecycle/course-lifecycle.controller';
import { CurriculumController } from './curriculum/curriculum.controller';
import { CourseCatalogService } from './course-catalog.service';
import { CourseEditingService } from './course-editing.service';
import { CourseDuplicationService } from './course-duplication.service';
import { CourseAccessService } from './course-access.service';
import { CourseLifecycleService } from './lifecycle/course-lifecycle.service';
import { CurriculumService } from './curriculum/curriculum.service';
import { CategoryService } from './category.service';
import { PrismaCourseRepository } from './repositories/course.repository';
import { PrismaCurriculumRepository } from './repositories/curriculum.repository';
import { PrismaCourseEditLog } from './repositories/edit-log.repository';
import { COURSE_READER } from './repositories/course.reader.interface';
import { COURSE_WRITER } from './repositories/course.writer.interface';
import {
  CURRICULUM_READER,
  CURRICULUM_WRITER,
} from './repositories/curriculum.repository.interface';
import { COURSE_EDIT_LOG } from './repositories/edit-log.repository.interface';
import { CATEGORY_REPOSITORY } from './repositories/category.repository.interface';
import { PrismaCategoryRepository } from './repositories/category.repository';

/**
 * The `catalog` bounded context: what a course *is*, how it is authored, and how it is found.
 *
 * It does not decide who may watch a lecture — that depends on purchases and refund
 * windows and belongs to the entitlement engine (task 1.8). It does not decide what a
 * course *should* cost either; coupons and tax are `PricingService` in commerce (1.9).
 * Catalog stores a number and a publish state, and answers questions about them.
 */
@Module({
  controllers: [
    CoursesController,
    InstructorCoursesController,
    CourseLifecycleController,
    CurriculumController,
    CategoriesController,
  ],
  providers: [
    CourseCatalogService,
    CourseEditingService,
    CourseDuplicationService,
    CourseAccessService,
    CourseLifecycleService,
    CurriculumService,
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

    PrismaCurriculumRepository,
    { provide: CURRICULUM_READER, useExisting: PrismaCurriculumRepository },
    { provide: CURRICULUM_WRITER, useExisting: PrismaCurriculumRepository },

    { provide: COURSE_EDIT_LOG, useClass: PrismaCourseEditLog },
    { provide: CATEGORY_REPOSITORY, useClass: PrismaCategoryRepository },
  ],
  exports: [CourseCatalogService],
})
export class CatalogModule {}
