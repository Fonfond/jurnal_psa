import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  changesQuerySchema,
  syncPushSchema,
  type SyncPushInput,
} from '@logbook/shared';
import { z } from 'zod';
import { CurrentUser } from '../common/current-user.decorator';
import type { AppRequest, AuthUser, RequestMeta } from '../common/types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SyncService } from './sync.service';

function metaOf(request: AppRequest): RequestMeta {
  return {
    requestId: request.requestId,
    ip: request.ip,
    userAgent: request.header('user-agent'),
    appVersion: request.header('x-app-version') ?? undefined,
    deviceKey: request.header('x-device-key') ?? undefined,
  };
}

@Controller('sync')
export class SyncController {
  constructor(@Inject(SyncService) private readonly sync: SyncService) {}

  @Post('push')
  @HttpCode(HttpStatus.OK)
  async push(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(syncPushSchema)) body: SyncPushInput,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.sync.push(user, body, metaOf(request));
  }

  @Get('changes')
  async changes(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(changesQuerySchema))
    query: z.infer<typeof changesQuerySchema>,
  ): Promise<Record<string, unknown>> {
    return this.sync.changes(user, query.since_seq, query.limit);
  }
}
