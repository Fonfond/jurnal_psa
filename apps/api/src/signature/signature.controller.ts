import { Controller, Get, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import type { AppRequest, AuthUser, RequestMeta } from '../common/types';
import { SignatureService, type SignatureInfo } from './signature.service';

function metaOf(request: AppRequest): RequestMeta {
  return {
    requestId: request.requestId,
    ip: request.ip,
    userAgent: request.header('user-agent'),
    appVersion: request.header('x-app-version') ?? undefined,
  };
}

@Controller('signature')
export class SignatureController {
  constructor(@Inject(SignatureService) private readonly signatures: SignatureService) {}

  /** Configured adapter + legal caveat (no secrets). */
  @Get('info')
  info(): SignatureInfo {
    return this.signatures.info;
  }

  /** Re-derives content and re-checks a stored signature. */
  @Post(':id/verify')
  @HttpCode(HttpStatus.OK)
  @Roles('supervisor', 'admin', 'auditor')
  async verify(
    @CurrentUser() _user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    return this.signatures.verifyById(id, metaOf(request));
  }
}
