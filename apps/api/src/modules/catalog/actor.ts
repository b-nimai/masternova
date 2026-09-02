import type { Role } from '@masternova/db';

/**
 * Who is asking. The two facts every authoring decision in this module needs, and nothing
 * else — a service that took the whole `User` would be able to make decisions on fields
 * that are none of its business.
 */
export interface Actor {
  readonly id: string;
  readonly role: Role;
}
