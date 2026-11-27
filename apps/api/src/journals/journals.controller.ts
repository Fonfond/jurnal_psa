import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  journalCreateSchema,
  journalMemberUpsertSchema,
  journalPatchSchema,
} from '@logbook/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import type { AppRequest, AuthUser, RequestMeta } from '../common/types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { JournalsService } from './journals.service';

function metaOf(request: AppRequest): RequestMeta {
  return {
    requestId: request.requestId,
    ip: request.ip,
    userAgent: request.header('user-agent'),
    appVersion: request.header('x-app-version') ?? undefined,
  };
}

@Controller()
export class JournalsController {
  constructor(@Inject(JournalsService) private readonly journals: JournalsService) {}

  @Get('journals')
  async list(@CurrentUser() user: AuthUser): Promise<Record<string, unknown>> {
    return this.journals.list(user);
  }

  @Get('journals/:id')
  async get(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Record<string, unknown>> {
    return this.journals.get(user, id);
  }

  @Get('admin/journals/:id/members')
  @Roles('admin')
  async members(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Record<string, unknown>> {
    return this.journals.members(user, id);
  }

  @Post('admin/journals')
  @Roles('admin')
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(journalCreateSchema))
    body: z.infer<typeof journalCreateSchema>,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.journals.create(user, body, metaOf(request));
  }

  @Patch('admin/journals/:id')
  @Roles('admin')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(journalPatchSchema))
    body: z.infer<typeof journalPatchSchema>,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.journals.update(user, id, body, metaOf(request));
  }

  @Put('admin/journals/:id/members/:userId')
  @Roles('admin')
  async upsertMember(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body(new ZodValidationPipe(journalMemberUpsertSchema))
    body: z.infer<typeof journalMemberUpsertSchema>,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.journals.upsertMember(
      user,
      id,
      userId,
      body.access_level,
      metaOf(request),
    );
  }

  @Delete('admin/journals/:id/members/:userId')
  @Roles('admin')
  async removeMember(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.journals.removeMember(user, id, userId, metaOf(request));
  }
}
