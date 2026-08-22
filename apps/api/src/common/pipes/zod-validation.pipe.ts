import { BadRequestException, PipeTransform } from '@nestjs/common';
import { ZodSchema } from 'zod';

/**
 * Validates a handler argument against a Zod schema and returns the parsed value.
 * Prefer the {@link ZodBody} decorator at call sites; this pipe is the implementation.
 * Schemas are shared end-to-end via @masternova/shared.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(result.error.flatten());
    }
    return result.data;
  }
}
