import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Recursively converts `bigint` values to strings in the response payload, so Prisma
 * `BigInt` columns (e.g. `Video.sizeBytes`) serialize as JSON strings without mutating
 * the global `BigInt.prototype`.
 */
@Injectable()
export class BigIntSerializerInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => serialize(data)));
  }
}

function serialize(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(serialize);
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serialize(v)]));
  }
  return value;
}
