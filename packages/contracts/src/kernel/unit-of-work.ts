import type { NewDomainEvent } from './domain-event.js';

/**
 * Unit of Work — runs a piece of work inside one database transaction, and commits any
 * events it raised in that same transaction.
 *
 * The force: a state change and the outbox rows describing it must commit together or not
 * at all. Left to convention, someone eventually writes the row outside the transaction,
 * and the failure mode is a silently-lost effect that only appears under load — an order
 * marked PAID with no enrollment and no receipt. Making the transaction the only way to
 * publish removes the opportunity.
 *
 * Deliberately NOT exposing the Prisma transaction type here: `@masternova/contracts` must
 * stay free of ORM types, or every module that publishes an event inherits a Prisma
 * dependency (CLAUDE.md §1 D). Repositories accept the executor; callers never unwrap it.
 */

/** Opaque transaction handle. Repositories know how to use it; domain code does not. */
export type TransactionExecutor = unknown;

export interface TransactionContext {
  /** Pass to a repository so its writes join this transaction. */
  readonly executor: TransactionExecutor;

  /**
   * Buffer an event. It is written to the outbox when the transaction commits — never
   * before, so a rollback cannot leave an event describing something that did not happen.
   */
  publish(event: NewDomainEvent): void;
}

export interface UnitOfWork {
  execute<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
