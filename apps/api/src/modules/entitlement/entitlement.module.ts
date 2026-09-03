import { Module } from '@nestjs/common';
import { ENTITLEMENT_GRANTING } from '@masternova/contracts';
import { StorageModule } from '@masternova/storage';
import type Redis from 'ioredis';
import { ConfigType } from '@nestjs/config';
import { s3Config } from '../../config/configuration';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { EntitlementEngine } from './entitlement-engine';
import { EntitlementService } from './entitlement.service';
import { EntitlementGuard } from './guards/entitlement.guard';
import { PlaybackController } from './playback.controller';
import { PlaybackService } from './playback.service';
import { PlaybackTokenService } from './playback-token.service';
import { ActiveEntitlementPolicy } from './policies/active-entitlement.policy';
import { AdminOverridePolicy } from './policies/admin-override.policy';
import { CourseOwnerPolicy } from './policies/course-owner.policy';
import { CoursePublishedPolicy } from './policies/course-published.policy';
import { FreeCoursePolicy } from './policies/free-course.policy';
import { PreviewLecturePolicy } from './policies/preview-lecture.policy';
import { RevokedEntitlementPolicy } from './policies/revoked-entitlement.policy';
import { ENTITLEMENT_POLICIES } from './policies/entitlement-policy.interface';
import { PrismaAccessSubjectReader } from './repositories/access-subject.reader';
import { ACCESS_SUBJECT_READER } from './repositories/access-subject.reader.interface';
import { CachedEntitlementRepository } from './repositories/cached-entitlement.repository';
import { PrismaEntitlementRepository } from './repositories/entitlement.repository';
import { ENTITLEMENT_REPOSITORY } from './repositories/entitlement.repository.interface';

/**
 * The chain, in one place.
 *
 * **This array is the extension point** (CLAUDE.md §1 O): task 1.11's coupon rule and a
 * cohort-window rule are each a new class and a new line here, with no existing policy
 * reopened. Adding one is also the only review that matters — a rule that lands but is
 * never listed does nothing, silently.
 *
 * The order is for reading, not for correctness. `EntitlementEngine` evaluates every policy
 * and lets `DENY` win regardless of position, precisely so that nobody has to get this list
 * right. Grouped allow-then-deny because that is how the rules read aloud.
 */
const POLICY_CHAIN = [
  AdminOverridePolicy,
  CourseOwnerPolicy,
  FreeCoursePolicy,
  PreviewLecturePolicy,
  ActiveEntitlementPolicy,
  CoursePublishedPolicy,
  RevokedEntitlementPolicy,
];

@Module({
  imports: [
    // Presigns the manifest and the poster. Async because the eager form reads its config
    // at import time, before a test has pointed `S3_ENDPOINT` at its container.
    StorageModule.forRootAsync({
      inject: [s3Config.KEY],
      useFactory: (config: ConfigType<typeof s3Config>) => config,
    }),
  ],
  controllers: [PlaybackController],
  providers: [
    ...POLICY_CHAIN,

    {
      provide: ENTITLEMENT_POLICIES,
      inject: POLICY_CHAIN,
      // Injected as an array rather than discovered by decorator scanning: the chain is
      // security-critical and a reviewer should be able to read every rule that runs from
      // one screen, without trusting that a `@Policy()` somewhere was picked up.
      useFactory: (...policies: unknown[]) => policies,
    },

    { provide: ACCESS_SUBJECT_READER, useClass: PrismaAccessSubjectReader },

    /**
     * **The Decorator, composed here.** `ENTITLEMENT_REPOSITORY` resolves to the cache,
     * which wraps the Prisma implementation — so every consumer gets caching and none of
     * them knows it, and taking the cache out is deleting this factory's wrapper.
     */
    PrismaEntitlementRepository,
    {
      provide: ENTITLEMENT_REPOSITORY,
      inject: [PrismaEntitlementRepository, REDIS_CLIENT],
      useFactory: (inner: PrismaEntitlementRepository, redis: Redis) =>
        new CachedEntitlementRepository(inner, redis),
    },

    EntitlementEngine,
    EntitlementService,
    PlaybackTokenService,
    PlaybackService,
    EntitlementGuard,

    /**
     * The grant/revoke half, published under a `contracts` token so commerce (task 1.9) can
     * reach it without importing this module's internals — the boundary rule in §4, which
     * the `boundaries` lint rule enforces. `useExisting`, so it is the same instance and
     * the cache is not duplicated.
     */
    { provide: ENTITLEMENT_GRANTING, useExisting: EntitlementService },
  ],
  // The guard and the service, for the modules that gate their own routes (catalog's
  // lecture detail, enrollment's progress writes in task 1.10).
  exports: [EntitlementService, EntitlementGuard, ENTITLEMENT_GRANTING],
})
export class EntitlementModule {}
