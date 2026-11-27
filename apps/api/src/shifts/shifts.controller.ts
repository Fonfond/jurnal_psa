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
} from '@nestjs/common';
import { z } from 'zod';
import {
  shiftActionSchema,
  shiftHandoverSchema,
  shiftListQuerySchema,
} from '@logbook/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import type { AppRequest, AuthUser, RequestMeta } from '../common/types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ShiftsService } from './shifts.service';

function metaOf(request: AppRequest): RequestMeta {
  return {
    requestId: request.requestId,
    ip: request.ip,
    userAgent: request.header('user-agent'),
    appVersion: request.header('x-app-version') ?? undefined,
  };
}

@Controller('shifts')
export class ShiftsController {
  constructor(@Inject(ShiftsService) private readonly shifts: ShiftsService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(shiftListQuerySchema))
    query: z.infer<typeof shiftListQuerySchema>,
  ): Promise<Record<string, unknown>> {
    return this.shifts.list(user, query);
  }

  @Get(':id')
  async get(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Record<string, unknown>> {
    return this.shifts.get(user, id);
  }

  @Post()
  @Roles('supervisor', 'admin')
  async handover(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(shiftHandoverSchema))
    body: z.infer<typeof shiftHandoverSchema>,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.shifts.handover(user, body, metaOf(request));
  }

  @Post(':id/accept')
  @Roles('supervisor', 'admin')
  async accept(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(shiftActionSchema))
    body: z.infer<typeof shiftActionSchema>,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.shifts.accept(user, id, body, metaOf(request));
  }

  @Post(':id/reject')
  @Roles('supervisor', 'admin')
  async reject(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(shiftActionSchema))
    body: z.infer<typeof shiftActionSchema>,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.shifts.reject(user, id, { ...body, action: 'reject' }, metaOf(request));
  }
}
