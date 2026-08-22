import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'masternova:idempotent';

/**
 * Marks a handler as requiring an `Idempotency-Key` header.
 *
 * Opt-in rather than applied to every POST. Most writes are not money and do not need the
 * storage and latency of a replay record; the ones that do — checkout, refunds, payouts —
 * should say so at the call site, where a reviewer can see it (CLAUDE.md §3: no mechanism
 * without a named force).
 */
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);
