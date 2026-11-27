import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AppRequest, AuthUser } from './types';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser => {
    const request = context.switchToHttp().getRequest<AppRequest>();
    if (!request.user) {
      throw new Error('CurrentUser used without AuthGuard');
    }
    return request.user;
  },
);
