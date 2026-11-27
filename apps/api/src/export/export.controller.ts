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
import { dateOnlySchema, uuidSchema } from '@logbook/shared';
import type { Response } from 'express';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import type { AppRequest, AuthUser, RequestMeta } from '../common/types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ExportService } from './export.service';

const exportCreateSchema = z
  .object({
    journal_id: uuidSchema.optional(),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
  })
  .strict()
  .default({});

const signedUrlSchema = z
  .object({
    format: z.enum(['pdf', 'csv']).default('pdf'),
  })
  .strict()
  .default({ format: 'pdf' });

const downloadQuerySchema = z.object({
  token: z.string().min(10).max(4096).optional(),
  format: z.enum(['pdf', 'csv']).default('pdf'),
});

const adminListQuerySchema = z.object({
  type: z.string().max(40).optional(),
  status: z.string().max(20).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
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
export class ExportController {
  constructor(@Inject(ExportService) private readonly exports: ExportService) {}

  /** Generates the WORM journal PDF + CSV export (JRN-07). */
  @Post('journal/exports')
  @Roles('supervisor', 'admin', 'auditor')
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(exportCreateSchema))
    body: z.infer<typeof exportCreateSchema>,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.exports.generateJournalExport(user, body, metaOf(request));
  }

  @Get('journal/exports/:id')
  @Roles('supervisor', 'admin', 'auditor')
  async details(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Record<string, unknown>> {
    return this.exports.getDetails(user, id);
  }

  /** Short-lived signed URL (≤15 min) for the generated PDF/CSV. */
  @Post('exports/:id/url')
  @Roles('supervisor', 'admin', 'auditor')
  async signedUrl(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(signedUrlSchema))
    body: z.infer<typeof signedUrlSchema>,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.exports.createSignedUrl(
      user,
      id,
      body.format,
      metaOf(request),
    );
  }

  @Get('exports/:id/download')
  @Roles('supervisor', 'admin', 'auditor')
  async download(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(downloadQuerySchema))
    query: z.infer<typeof downloadQuerySchema>,
    @Req() request: AppRequest,
    @Res() response: Response,
  ): Promise<void> {
    await this.sendExport(user, id, query, request, response);
  }

  // Admin-console aliases (S-16): same WORM exports under /v1/admin/exports.
  @Get('admin/exports')
  @Roles('admin')
  async adminList(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(adminListQuerySchema))
    query: z.infer<typeof adminListQuerySchema>,
  ): Promise<Record<string, unknown>> {
    return this.exports.listExports(user, query);
  }

  @Post('admin/exports')
  @Roles('admin')
  async adminCreate(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(exportCreateSchema))
    body: z.infer<typeof exportCreateSchema>,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.exports.generateJournalExport(user, body, metaOf(request));
  }

  @Get('admin/exports/:id')
  @Roles('admin')
  async adminDetails(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Record<string, unknown>> {
    return this.exports.getDetails(user, id);
  }

  @Post('admin/exports/:id/url')
  @Roles('admin')
  async adminSignedUrl(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(signedUrlSchema))
    body: z.infer<typeof signedUrlSchema>,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.exports.createSignedUrl(user, id, body.format, metaOf(request));
  }

  @Get('admin/exports/:id/download')
  @Roles('admin')
  async adminDownload(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(downloadQuerySchema))
    query: z.infer<typeof downloadQuerySchema>,
    @Req() request: AppRequest,
    @Res() response: Response,
  ): Promise<void> {
    await this.sendExport(user, id, query, request, response);
  }

  private async sendExport(
    user: AuthUser,
    id: string,
    query: z.infer<typeof downloadQuerySchema>,
    request: AppRequest,
    response: Response,
  ): Promise<void> {
    const result = await this.exports.download(
      user,
      id,
      query.token,
      query.format,
      metaOf(request),
    );
    response.setHeader(
      'Content-Type',
      query.format === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8',
    );
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.filename}"`,
    );
    response.setHeader('X-Content-SHA256', result.hash);
    response.setHeader('Content-Length', String(result.buffer.length));
    response.end(result.buffer);
  }
}
