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
import { CSRF_COOKIE } from './auth.constants';

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AppRequest>();
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return true;
    }

    const cookie = request.cookies?.[CSRF_COOKIE] as string | undefined;
    const header = request.header('x-csrf-token');
    if (!cookie || !header || cookie !== header) {
      throw new DomainError(
        'E-AUTH-02',
        'CSRF-токен отсутствует или не совпадает',
      );
    }
    return true;
  }
}
