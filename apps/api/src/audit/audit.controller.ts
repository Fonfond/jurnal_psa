import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../common/current-user.decorator';
import type { AuthUser } from '../common/types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuditService } from './audit.service';

const auditQuerySchema = z.object({
  action: z.string().max(40).optional(),
  entity_type: z.string().max(32).optional(),
  entity_id: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const exportSchema = z.object({
  type: z.enum(['audit', 'entries', 'user_data']),
  params: z.record(z.string(), z.unknown()).optional(),
});

@Controller()
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get('audit')
  async list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(auditQuerySchema))
    query: z.infer<typeof auditQuerySchema>,
  ): Promise<{ items: Array<Record<string, unknown>> }> {
    return {
      items: await this.audit.list(
        { id: user.id, role: user.role, departmentId: user.departmentId },
        query,
      ),
    };
  }

  @Post('exports')
  async createExport(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(exportSchema))
    body: z.infer<typeof exportSchema>,
  ): Promise<Record<string, unknown>> {
    return this.audit.createExport(user.id, body.type);
  }

  @Get('exports/:id')
  async getExport(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Record<string, unknown>> {
    return this.audit.getExport(user.id, user.role, id);
  }
}
