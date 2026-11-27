import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { roleSchema, uuidSchema } from '@logbook/shared';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import type { AppRequest, AuthUser, RequestMeta } from '../common/types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminService } from './admin.service';

const createUserSchema = z.object({
  email: z.string().email(),
  full_name: z.string().min(2).max(200),
  role: roleSchema,
  department_id: uuidSchema,
  position: z.string().max(120).optional(),
  external_id: z.string().max(64).optional(),
  /** Local demo password; hashed into user_credentials, never stored in clear. */
  password: z.string().min(8).max(128),
});

const patchUserSchema = z.object({
  full_name: z.string().min(2).max(200).optional(),
  role: roleSchema.optional(),
  department_id: uuidSchema.optional(),
  status: z.enum(['active', 'blocked', 'deactivated']).optional(),
  position: z.string().max(120).optional(),
});

const usersQuerySchema = z.object({
  search: z.string().max(200).optional(),
  role: roleSchema.optional(),
  status: z.enum(['active', 'blocked', 'deactivated']).optional(),
  department_id: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function metaOf(request: AppRequest): RequestMeta {
  return {
    requestId: request.requestId,
    ip: request.ip,
    userAgent: request.header('user-agent'),
  };
}

/**
 * Admin directory (ADR-14, ADM-01/ADM-02/ADM-04).
 * Routes stay under `/v1/admin/*`; the admin SPA is served from a separate
 * origin, so the API only exposes the data and enforces the `admin` role.
 */
@Controller('admin')
@Roles('admin')
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  @Get('users')
  async list(
    @Query(new ZodValidationPipe(usersQuerySchema))
    query: z.infer<typeof usersQuerySchema>,
  ): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
    return this.admin.listUsers(query);
  }

  @Post('users')
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createUserSchema))
    body: z.infer<typeof createUserSchema>,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.admin.createUser(user, body, metaOf(request));
  }

  @Patch('users/:id')
  async patch(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(patchUserSchema))
    body: z.infer<typeof patchUserSchema>,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.admin.patchUser(user, id, body, metaOf(request));
  }

  @Post('users/:id/revoke-sessions')
  async revoke(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.admin.revokeSessions(user, id, metaOf(request));
  }

  @Get('departments')
  async departments(): Promise<{ items: Array<Record<string, unknown>> }> {
    return { items: await this.admin.listDepartments() };
  }

}

