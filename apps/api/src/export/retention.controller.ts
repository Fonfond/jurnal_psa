import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { dateOnlySchema, uuidSchema } from '@logbook/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import type { AppRequest, AuthUser, RequestMeta } from '../common/types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RetentionSchedulerService } from './retention-scheduler.service';
import { RetentionService } from './retention.service';

const reportQuerySchema = z.object({
  now: z.string().datetime({ offset: true }).optional(),
});

const alertsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const schedulerRunSchema = z
  .object({
    now: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .default({});

const runSchema = z
  .object({
    now: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .default({});

const archiveSchema = z
  .object({
    journal_id: uuidSchema.optional(),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
  })
  .strict()
  .default({});

const checkpointSchema = z
  .object({
    label: z.string().max(120).optional(),
  })
  .strict()
  .default({});

function metaOf(request: AppRequest): RequestMeta {
  return {
    requestId: request.requestId,
    ip: request.ip,
    userAgent: request.header('user-agent'),
  };
}

@Controller()
@Roles('admin', 'auditor')
export class RetentionController {
  constructor(
    @Inject(RetentionService) private readonly retention: RetentionService,
    @Inject(RetentionSchedulerService)
    private readonly scheduler: RetentionSchedulerService,
  ) {}

  @Get('admin/retention')
  async report(
    @Query(new ZodValidationPipe(reportQuerySchema))
    query: z.infer<typeof reportQuerySchema>,
  ): Promise<Record<string, unknown>> {
    return this.retention.report(query.now);
  }

  @Get('admin/retention/alerts')
  async alerts(
    @Query(new ZodValidationPipe(alertsQuerySchema))
    query: z.infer<typeof alertsQuerySchema>,
  ): Promise<Record<string, unknown>> {
    return { items: await this.retention.listAlerts(query.limit) };
  }

  @Post('admin/retention/scheduler/run')
  @Roles('admin')
  async runScheduledNow(
    @Body(new ZodValidationPipe(schedulerRunSchema))
    body: z.infer<typeof schedulerRunSchema>,
  ): Promise<Record<string, unknown>> {
    return this.scheduler.runNow(body.now);
  }

  @Post('admin/retention/run')
  @Roles('admin')
  async run(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(runSchema)) body: z.infer<typeof runSchema>,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.retention.run(user, metaOf(request), body.now);
  }

  @Post('admin/retention/archive')
  @Roles('admin')
  async archive(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(archiveSchema))
    body: z.infer<typeof archiveSchema>,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.retention.archive(user, body, metaOf(request));
  }

  @Get('admin/retention/archives')
  async archives(@CurrentUser() user: AuthUser): Promise<Record<string, unknown>> {
    return this.retention.listArchives(user);
  }

  @Get('admin/audit/verify')
  async verifyAudit(): Promise<Record<string, unknown>> {
    return this.retention.verifyAudit() as unknown as Record<string, unknown>;
  }

  @Get('admin/backup/manifest')
  async backupManifest(@CurrentUser() user: AuthUser): Promise<Record<string, unknown>> {
    return this.retention.backupManifest(user);
  }

  @Post('admin/backup/checkpoint')
  @Roles('admin')
  async checkpoint(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(checkpointSchema))
    body: z.infer<typeof checkpointSchema>,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.retention.checkpoint(user, body.label, metaOf(request));
  }
}
