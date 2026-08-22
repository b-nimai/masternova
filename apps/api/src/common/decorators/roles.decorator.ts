import { SetMetadata } from '@nestjs/common';
import type { Role } from '@masternova/db';

export const ROLES_KEY = 'masternova:roles';

/** Coarse role gate. Anything finer than "which kind of user" belongs to the entitlement engine (task 1.8). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
