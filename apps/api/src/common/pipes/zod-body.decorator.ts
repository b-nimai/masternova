import { Body } from '@nestjs/common';
import type { ZodSchema } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';

/**
 * `@ZodBody(schema)` — validates the request body against a Zod schema and injects the
 * parsed, typed value. Sugar over `@Body(new ZodValidationPipe(schema))` so handlers
 * don't repeat the pipe wiring. Schemas are shared end-to-end via @masternova/shared.
 */
export function ZodBody<T>(schema: ZodSchema<T>): ParameterDecorator {
  return Body(new ZodValidationPipe(schema));
}
