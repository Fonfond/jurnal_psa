import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { z } from 'zod';
import { uuidSchema } from '@logbook/shared';
import { CurrentUser } from '../common/current-user.decorator';
import type { AuthUser } from '../common/types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { GroundingsService } from './groundings.service';

const listQuerySchema = z.object({
  journal_id: uuidSchema.optional(),
  site_id: uuidSchema.optional(),
  state: z.enum(['applied', 'removed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

@Controller('groundings')
export class GroundingsController {
  constructor(@Inject(GroundingsService) private readonly groundings: GroundingsService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listQuerySchema))
    query: z.infer<typeof listQuerySchema>,
  ): Promise<Record<string, unknown>> {
    return this.groundings.list(user, query);
  }

  @Get(':id')
  async get(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Record<string, unknown>> {
    return this.groundings.get(user, id);
  }
}
