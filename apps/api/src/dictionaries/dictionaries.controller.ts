import { Body, Controller, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import type { AppRequest, AuthUser, RequestMeta } from '../common/types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DictionariesService } from './dictionaries.service';

const patchSchema = z.object({
  items: z.array(z.record(z.string(), z.unknown())).max(500).optional(),
});

const rawSiteSchema = z.object({
  site_name_raw: z.string().trim().min(2).max(120),
});

const createSiteSchema = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().min(2).max(32).optional(),
});

const bindSiteSchema = rawSiteSchema.extend({
  site_id: z.string().uuid(),
});

function metaOf(request: AppRequest): RequestMeta {
  return {
    requestId: request.requestId,
    ip: request.ip,
    userAgent: request.header('user-agent'),
  };
}

@Controller()
export class DictionariesController {
  constructor(
    @Inject(DictionariesService) private readonly dictionaries: DictionariesService,
  ) {}

  @Get('dictionaries/snapshot')
  async snapshot(@CurrentUser() user: AuthUser): Promise<Record<string, unknown>> {
    return this.dictionaries.snapshot(user);
  }

  @Patch('admin/dictionaries/:name')
  @Roles('admin')
  async patch(
    @CurrentUser() user: AuthUser,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(patchSchema)) body: z.infer<typeof patchSchema>,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.dictionaries.patch(user, name, body, metaOf(request));
  }

  @Get('admin/sites/unresolved')
  @Roles('supervisor', 'admin')
  async unresolved() {
    return this.dictionaries.unresolvedSites();
  }

  @Post('admin/sites/from-raw')
  @Roles('supervisor', 'admin')
  async createFromRaw(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createSiteSchema))
    body: z.infer<typeof createSiteSchema>,
    @Req() request: AppRequest,
  ) {
    return this.dictionaries.createSiteFromRaw(user, body, metaOf(request));
  }

  @Post('admin/sites/bind-from-raw')
  @Roles('supervisor', 'admin')
  async bindFromRaw(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(bindSiteSchema))
    body: z.infer<typeof bindSiteSchema>,
    @Req() request: AppRequest,
  ) {
    return this.dictionaries.bindSiteFromRaw(
      user,
      body.site_name_raw,
      body.site_id,
      metaOf(request),
    );
  }

  @Post('admin/sites/ignore-raw')
  @Roles('supervisor', 'admin')
  async ignoreRaw(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(rawSiteSchema))
    body: z.infer<typeof rawSiteSchema>,
    @Req() request: AppRequest,
  ) {
    return this.dictionaries.ignoreRaw(user, body.site_name_raw, metaOf(request));
  }
}
