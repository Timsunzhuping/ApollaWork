import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';

/** 用 protocol 的 zod schema 校验请求体。 */
export class ZodBody<T extends ZodTypeAny> implements PipeTransform {
  constructor(private schema: T) {}
  transform(value: unknown): z.infer<T> {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw new BadRequestException(
        r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    return r.data;
  }
}
