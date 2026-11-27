import { Body, Controller, Get, Inject, Param, Patch, Req } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import type { AppRequest, AuthUser, RequestMeta } from '../common/types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DictionariesService } from './dictionaries.service';

const patchSchema = z.object({
  items: z.array(z.record(z.string(), z.unknown())).max(500).optional(),
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
}
