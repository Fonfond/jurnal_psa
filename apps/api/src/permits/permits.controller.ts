import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import type { AppRequest, AuthUser, RequestMeta } from '../common/types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { Response } from 'express';
import { PermitPdfService } from './permit-pdf.service';
import { PermitsService } from './permits.service';

const listQuerySchema = z.object({
  status: z
    .enum(['draft', 'active', 'suspended', 'closed', 'annulled'])
    .optional(),
  site_id: z.string().uuid().optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

const importSchema = z
  .object({
    source_id: z.string().min(1).max(32).default('csv'),
    /** CSV export from the permit system. */
    csv: z.string().min(1).max(2_000_000).optional(),
    /** JSON records from an external source adapter (OQ-03). */
    records: z.array(z.record(z.string(), z.unknown())).min(1).max(5000).optional(),
  })
  .refine((value) => Boolean(value.csv) || Boolean(value.records), {
    message: 'Передайте CSV или массив записей нарядов',
  });

const pdfTokenSchema = z.object({
  token: z.string().min(10).max(4096).optional(),
});

function metaOf(request: AppRequest): RequestMeta {
  return {
    requestId: request.requestId,
    ip: request.ip,
    userAgent: request.header('user-agent'),
  };
}

@Controller()
export class PermitsController {
  constructor(
    @Inject(PermitsService) private readonly permits: PermitsService,
    @Inject(PermitPdfService) private readonly pdf: PermitPdfService,
  ) {}

  @Get('permits')
  async list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listQuerySchema))
    query: z.infer<typeof listQuerySchema>,
  ): Promise<Record<string, unknown>> {
    return this.permits.list(user, query);
  }

  @Get('permits/:id')
  async get(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Record<string, unknown>> {
    return this.permits.get(user, id);
  }

  /** Issues a short-lived signed URL for the permit PDF (OQ-03). */
  @Post('permits/:id/pdf-url')
  @HttpCode(200)
  async pdfUrl(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.pdf.createUrl(user, id, metaOf(request));
  }

  /** Signed-URL download: generated PDF or redirect to the external deep link. */
  @Get('permits/pdf/:id')
  async pdfDownload(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(pdfTokenSchema))
    query: z.infer<typeof pdfTokenSchema>,
    @Req() request: AppRequest,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.pdf.download(user, id, query.token, metaOf(request));
    if ('redirect' in result) {
      response.redirect(302, result.redirect);
      return;
    }
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.filename}"`,
    );
    response.setHeader('X-Content-SHA256', result.hash);
    response.setHeader('Content-Length', String(result.size_bytes));
    response.end(result.pdf);
  }

  @Post('admin/permits/import')
  @Roles('admin')
  async import(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(importSchema)) body: z.infer<typeof importSchema>,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.permits.importCsv(user, body, metaOf(request));
  }

  @Get('admin/imports')
  @Roles('admin')
  async imports(@CurrentUser() user: AuthUser): Promise<Record<string, unknown>> {
    return this.permits.imports(user);
  }
}
