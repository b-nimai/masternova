import { Inject, Injectable } from '@nestjs/common';
import type { EntitlementSource } from '@masternova/db';
import type { TransactionContext, UnitOfWork } from '@masternova/contracts';
import {
  CourseNotFoundException,
  EntitlementDeniedException,
  LectureNotFoundException,
} from '../../common/exceptions';
import { Verdict } from './decision';
import { EntitlementEngine, type EntitlementDecision } from './entitlement-engine';
import type { EntitlementContext } from './entitlement-context';
import {
  ACCESS_SUBJECT_READER,
  type IAccessSubjectReader,
  type LectureSubject,
} from './repositories/access-subject.reader.interface';
import {
  ENTITLEMENT_REPOSITORY,
  type EntitlementKey,
  type IEntitlementRepository,
} from './repositories/entitlement.repository.interface';

/** Who is asking. The same two facts catalog's `Actor` carries, and for the same reason. */
export interface AccessActor {
  readonly id: string;
  readonly role: 'LEARNER' | 'INSTRUCTOR' | 'ADMIN';
}

/**
 * The module's public face: assemble the context, run the chain, answer the question.
 *
 * It is deliberately thin. The rules live in `policies/`, the reduction lives in
 * `EntitlementEngine`, the caching lives in the repository Decorator — this only gathers
 * the three reads and turns a verdict into either a boolean, an explanation, or an
 * exception. If a rule ever appears in this file, it is in the wrong place.
 */
@Injectable()
export class EntitlementService {
  constructor(
    @Inject(ACCESS_SUBJECT_READER) private readonly subjects: IAccessSubjectReader,
    @Inject(ENTITLEMENT_REPOSITORY) private readonly entitlements: IEntitlementRepository,
    private readonly engine: EntitlementEngine,
  ) {}

  /** "Is this course in my library, and may I open it?" — no lecture in the question. */
  async decideForCourse(courseId: string, actor: AccessActor): Promise<EntitlementDecision> {
    const course = await this.subjects.findCourse(courseId);
    if (!course) throw new CourseNotFoundException();

    return this.engine.decide(await this.contextFor(course, undefined, actor));
  }

  /** "May I play this lecture?" — the decision the guard and the playback path both make. */
  async decideForLecture(lectureId: string, actor: AccessActor): Promise<EntitlementDecision> {
    const subject = await this.subjects.lectureWithCourse(lectureId);
    if (!subject) throw new LectureNotFoundException();

    return this.engine.decide(await this.contextFor(subject.course, subject.lecture, actor));
  }

  /**
   * The same decision, plus the lecture — so a caller that is about to issue a playback
   * token does not fetch the lecture a second time to find its `assetId`.
   */
  async authorizeLecture(
    lectureId: string,
    actor: AccessActor,
  ): Promise<{ lecture: LectureSubject; courseId: string }> {
    const subject = await this.subjects.lectureWithCourse(lectureId);
    if (!subject) throw new LectureNotFoundException();

    const decision = this.engine.decide(
      await this.contextFor(subject.course, subject.lecture, actor),
    );

    if (decision.verdict !== Verdict.Allow) {
      throw new EntitlementDeniedException(decision.reason, subject.course.id);
    }

    return { lecture: subject.lecture, courseId: subject.course.id };
  }

  /**
   * Granting is here rather than in commerce because the *rule* for what a grant means
   * belongs to this context. Commerce raises `order.paid`; the handler calls this.
   *
   * **Use the `*InTransaction` variants below when there is a transaction to join.** Passing
   * a raw `executor` here is supported but leaves the cache alone, because the write is not
   * durable until the caller commits — see {@link IEntitlementRepository.forget}.
   */
  async grant(
    input: {
      userId: string;
      courseId: string;
      source: EntitlementSource;
      orderId?: string | null;
      expiresAt?: Date | null;
    },
    executor?: unknown,
  ): Promise<void> {
    await this.entitlements.grant(input, executor);
  }

  async revoke(
    userId: string,
    courseId: string,
    reason: string,
    executor?: unknown,
  ): Promise<void> {
    await this.entitlements.revoke(userId, courseId, reason, executor);
  }

  /** Refund and chargeback: revoke everything one order paid for. */
  async revokeByOrder(
    orderId: string,
    reason: string,
    executor?: unknown,
  ): Promise<readonly EntitlementKey[]> {
    return this.entitlements.revokeByOrder(orderId, reason, executor);
  }

  /**
   * The transactional forms, for commerce (task 1.9).
   *
   * **The ordering is the whole point of these existing.** The entitlement must commit in
   * the same transaction as the order that paid for it — writing it separately is a dual
   * write, and the window between them is a learner who paid and cannot watch. But the
   * cache must be dropped **after** that commit, never inside it: a `DEL` issued mid-
   * transaction is followed by a concurrent read that re-caches the pre-write row for the
   * full TTL, so a refund silently keeps working for five minutes.
   *
   * Only the owner of the transaction knows when it committed, which is why these live here
   * and not in the Decorator.
   */
  async grantInTransaction(
    input: {
      userId: string;
      courseId: string;
      source: EntitlementSource;
      orderId?: string | null;
      expiresAt?: Date | null;
    },
    uow: UnitOfWork,
    work?: (ctx: TransactionContext) => Promise<void>,
  ): Promise<void> {
    await uow.execute(async (ctx) => {
      await this.entitlements.grant(input, ctx.executor);
      await work?.(ctx);
    });

    await this.entitlements.forget([{ userId: input.userId, courseId: input.courseId }]);
  }

  /** The refund path: revoke inside the order's transaction, forget once it has committed. */
  async revokeByOrderInTransaction(
    orderId: string,
    reason: string,
    uow: UnitOfWork,
    work?: (ctx: TransactionContext) => Promise<void>,
  ): Promise<readonly EntitlementKey[]> {
    const revoked = await uow.execute(async (ctx) => {
      const keys = await this.entitlements.revokeByOrder(orderId, reason, ctx.executor);
      await work?.(ctx);
      return keys;
    });

    await this.entitlements.forget(revoked);
    return revoked;
  }

  /**
   * The one read that can be skipped, skipped.
   *
   * Staff never need an entitlement row — an admin is allowed by `AdminOverridePolicy` and
   * an instructor by `CourseOwnerPolicy`, and neither reads `context.entitlement`. Fetching
   * it anyway would put a Redis round trip and a possible Postgres query on every request
   * the instructor dashboard makes, to produce a value nothing looks at.
   */
  private async contextFor(
    course: EntitlementContext['course'],
    lecture: LectureSubject | undefined,
    actor: AccessActor,
  ): Promise<EntitlementContext> {
    const staff = actor.role === 'ADMIN' || course.instructorId === actor.id;

    return {
      actor,
      course,
      lecture,
      entitlement: staff ? null : await this.entitlements.find(actor.id, course.id),
      now: new Date(),
    };
  }
}
