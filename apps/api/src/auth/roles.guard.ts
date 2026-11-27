import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError, type Role } from '@logbook/shared';
import { ROLES_KEY } from '../common/roles.decorator';
import type { AppRequest } from '../common/types';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles || roles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AppRequest>();
    if (!request.user) {
      throw new DomainError('E-AUTH-01', 'Требуется вход');
    }
    if (!roles.includes(request.user.role)) {
      throw new DomainError('E-AUTH-02', 'Недостаточно прав');
    }
    return true;
  }
}
