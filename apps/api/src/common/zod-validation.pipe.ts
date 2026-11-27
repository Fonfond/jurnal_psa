import {
  type ArgumentMetadata,
  type PipeTransform,
  Injectable,
} from '@nestjs/common';
import type { ZodTypeAny } from 'zod';
import { DomainError } from '@logbook/shared';

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodTypeAny) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    const result = this.schema.safeParse(value);
    if (result.success) {
      return result.data;
    }

    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key =
        issue.path.length > 0
          ? issue.path.map((part) => String(part)).join('.')
          : '_';
      if (!fields[key]) {
        fields[key] = issue.message;
      }
    }

    throw new DomainError('E-VAL-01', 'Ошибка валидации', fields);
  }
}
