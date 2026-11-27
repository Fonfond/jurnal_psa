import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { AppRequest } from './types';

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AppRequest>();

    return next.handle().pipe(
      map((data: unknown) => {
        if (data === undefined || data === null) {
          return data;
        }
        if (typeof data !== 'object' || Buffer.isBuffer(data)) {
          return data;
        }
        return {
          ...(data as Record<string, unknown>),
          server_time: new Date().toISOString(),
          request_id: request.requestId,
        };
      }),
    );
  }
}
