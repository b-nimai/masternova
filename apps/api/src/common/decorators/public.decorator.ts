import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'masternova:public';

/**
 * Opts a route out of authentication.
 *
 * The guard is global and everything is protected by default, so forgetting a decorator
 * fails closed (a 401 on a route that should be open) rather than open (an unauthenticated
 * route nobody noticed). That asymmetry is the whole reason it is opt-out, not opt-in.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
