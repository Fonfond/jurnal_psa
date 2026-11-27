import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  deviceRegisterSchema,
  type DeviceRegisterInput,
  type DeviceRegistrationResponse,
  type RegisteredDevice,
} from '@logbook/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import type { AppRequest, AuthUser, RequestMeta } from '../common/types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DevicesService, type AdminDeviceRow } from './devices.service';

const adminDevicesQuerySchema = z.object({
  search: z.string().max(200).optional(),
  status: z.enum(['active', 'revoked']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
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
export class DevicesController {
  constructor(@Inject(DevicesService) private readonly devices: DevicesService) {}

  @Get('devices')
  async list(
    @CurrentUser() user: AuthUser,
  ): Promise<{ items: RegisteredDevice[] }> {
    return { items: await this.devices.list(user.id) };
  }

  /** Admin inventory of every device of every user (ADR-14). */
  @Get('admin/devices')
  @Roles('admin')
  async listAll(
    @Query(new ZodValidationPipe(adminDevicesQuerySchema))
    query: z.infer<typeof adminDevicesQuerySchema>,
  ): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
    return this.devices.listAll(query) as unknown as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
  }

  @Delete('admin/devices/:id')
  @Roles('admin')
  async revokeAsAdmin(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: AppRequest,
  ): Promise<{ ok: true; revoked_sessions: number }> {
    return this.devices.revoke(user, id, metaOf(request));
  }

  /** Idempotent device registration by install_id; returns the key once. */
  @Post('devices')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(deviceRegisterSchema)) body: DeviceRegisterInput,
    @Req() request: AppRequest,
  ): Promise<DeviceRegistrationResponse> {
    return this.devices.register(user, body, metaOf(request));
  }

  @Delete('devices/:id')
  async revoke(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: AppRequest,
  ): Promise<{ ok: true; revoked_sessions: number }> {
    return this.devices.revoke(user, id, metaOf(request));
  }
}
