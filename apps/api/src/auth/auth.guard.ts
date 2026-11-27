import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError } from '@logbook/shared';
import { IS_PUBLIC_KEY } from '../common/public.decorator';
import type { AppRequest } from '../common/types';
import { AuthService } from './auth.service';
import { SESSION_COOKIE } from './auth.constants';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AppRequest>();
    const token = request.cookies?.[SESSION_COOKIE] as string | undefined;
    if (!token) {
      throw new DomainError('E-AUTH-01', 'Требуется вход');
    }

    const resolved = await this.auth.resolveSession(token);
    if (!resolved) {
      throw new DomainError('E-AUTH-01', 'Сессия недействительна');
    }

    request.user = {
      id: resolved.user.id,
      role: resolved.user.role,
      departmentId: resolved.user.departmentId,
      fullName: resolved.user.fullName,
      email: resolved.user.email,
      sessionId: resolved.sessionId,
      sessionExpiresAt: resolved.expiresAt,
    };

    void this.auth.touchSession(resolved.sessionId).catch(() => undefined);
    return true;
  }
}
