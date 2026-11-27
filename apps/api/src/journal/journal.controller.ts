import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { z } from 'zod';
import {
  dateOnlySchema,
  signatureRequestSchema,
  type SignatureRecord,
  uuidSchema,
} from '@logbook/shared';
import type { Response } from 'express';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import type { AppRequest, AuthUser, RequestMeta } from '../common/types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { JournalService } from './journal.service';

const listQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  permit_id: uuidSchema.optional(),
  author_id: uuidSchema.optional(),
  work_type_id: uuidSchema.optional(),
  site_id: uuidSchema.optional(),
  journal_id: uuidSchema.optional(),
  status: z.enum(['active', 'deleted']).default('active'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

const commentSchema = z
  .object({
    comment: z.string().max(200).optional(),
  })
  .default({});

const conflictsQuerySchema = z.object({
  resolution: z.enum(['local', 'remote', 'manual', 'pending']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

const resolveSchema = z.object({
  resolution: z.enum(['local', 'remote', 'manual']),
  values: z.record(z.string(), z.unknown()).optional(),
  comment: z.string().max(200).optional(),
});

const reviewsQuerySchema = z.object({
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  journal_id: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const reviewCreateSchema = z.object({
  journal_id: uuidSchema.optional(),
  period_start: dateOnlySchema,
  period_end: dateOnlySchema,
  remarks: z.string().max(2000).optional(),
});

const exportQuerySchema = z.object({
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  journal_id: uuidSchema.optional(),
  format: z.enum(['csv']).default('csv'),
});

function metaOf(request: AppRequest): RequestMeta {
  return {
    requestId: request.requestId,
    ip: request.ip,
    userAgent: request.header('user-agent'),
    appVersion: request.header('x-app-version') ?? undefined,
  };
}

@Controller()
export class JournalController {
  constructor(@Inject(JournalService) private readonly journal: JournalService) {}

  @Get('entries')
  async list(    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listQuerySchema))
    query: z.infer<typeof listQuerySchema>,
  ): Promise<Record<string, unknown>> {
    return this.journal.list(user, query);
  }

  @Get('entries/:id')
  async get(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Record<string, unknown>> {
    return this.journal.get(user, id);
  }

  @Post('entries/:id/verify')
  @Roles('supervisor', 'admin')
  async verify(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.journal.verify(user, id, metaOf(request));
  }

  @Post('entries/:id/unverify')
  @Roles('supervisor', 'admin')
  async unverify(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(commentSchema)) body: { comment?: string },
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.journal.unverify(user, id, metaOf(request), body.comment);
  }

  @Post('entries/:id/restore')
  @Roles('admin')
  async restore(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.journal.restore(user, id, metaOf(request));
  }

  @Get('journal/reviews')
  @Roles('supervisor', 'admin')
  async reviews(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(reviewsQuerySchema))
    query: z.infer<typeof reviewsQuerySchema>,
  ): Promise<Record<string, unknown>> {
    return this.journal.listReviews(user, query);
  }

  @Post('journal/reviews')
  @Roles('supervisor', 'admin')
  async createReview(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(reviewCreateSchema))
    body: z.infer<typeof reviewCreateSchema>,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.journal.createReview(user, body, metaOf(request));
  }

  @Get('journal/export')
  async exportCsv(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(exportQuerySchema))
    query: z.infer<typeof exportQuerySchema>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const csv = await this.journal.exportCsv(user, query);
    response.type('text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="logbook-journal-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    return csv;
  }

  /** Manual review signature through the configured ЭП adapter. */
  @Post('journal/reviews/:id/sign')
  @Roles('supervisor', 'admin')
  async signReview(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(signatureRequestSchema)) _body: { reason?: string },
    @Req() request: AppRequest,
  ): Promise<SignatureRecord> {
    return this.journal.signReview(user, id, metaOf(request));
  }

  @Get('journal/reviews/:id/signatures')
  @Roles('supervisor', 'admin', 'auditor')
  async reviewSignatures(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ items: SignatureRecord[] }> {
    return this.journal.listReviewSignatures(user, id);
  }

  /** Manual visa signature for a verified entry. */
  @Post('entries/:id/sign')
  @Roles('supervisor', 'admin')
  async signEntry(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(signatureRequestSchema)) _body: { reason?: string },
    @Req() request: AppRequest,
  ): Promise<SignatureRecord> {
    return this.journal.signEntryVisa(user, id, metaOf(request));
  }

  @Get('conflicts')
  @Roles('supervisor', 'admin', 'auditor')
  async conflicts(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(conflictsQuerySchema))
    query: z.infer<typeof conflictsQuerySchema>,
  ): Promise<Record<string, unknown>> {
    return this.journal.listConflicts(user, query.resolution, query.limit);
  }

  @Post('conflicts/:id/resolve')
  @Roles('supervisor', 'admin')
  async resolve(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(resolveSchema))
    body: z.infer<typeof resolveSchema>,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.journal.resolveConflict(user, id, body, metaOf(request));
  }
}
