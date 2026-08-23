import { Query } from '@nestjs/common';
import type { ZodSchema } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';

/**
 * `@ZodQuery(schema)` — the query-string twin of {@link ZodBody}.
 *
 * A catalog is filtered through the query string, and every value in one arrives as a
 * string. The schemas in `@masternova/shared` coerce (`z.coerce.number()`), so the handler
 * receives real numbers and booleans rather than doing it by hand nine times.
 */
export function ZodQuery<T>(schema: ZodSchema<T>): ParameterDecorator {
  return Query(new ZodValidationPipe(schema));
}
