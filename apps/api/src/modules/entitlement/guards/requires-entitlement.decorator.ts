import { SetMetadata } from '@nestjs/common';

export const ENTITLEMENT_PARAM_KEY = 'masternova:entitlement-param';

/** Which route parameter names the thing being accessed, and what kind of thing it is. */
export interface EntitlementTarget {
  readonly param: string;
  readonly kind: 'lecture' | 'course';
}

/**
 * Marks a route as needing an entitlement, and says where to find the subject.
 *
 * The parameter name is declared rather than guessed. A guard that hunted for `:id` would
 * silently pass on any route that happened to name it something else — and an authorization
 * check that silently passes is worse than one that is not there, because it looks present
 * in review.
 */
export const RequiresEntitlement = (kind: EntitlementTarget['kind'], param = 'id') =>
  SetMetadata(ENTITLEMENT_PARAM_KEY, { kind, param } satisfies EntitlementTarget);
