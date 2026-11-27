import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { DomainError } from '@logbook/shared';
import type { Response } from 'express';
import type { AppRequest } from './types';

const STATUS_TO_CODE: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'E-VAL-01',
  [HttpStatus.UNAUTHORIZED]: 'E-AUTH-01',
  [HttpStatus.FORBIDDEN]: 'E-AUTH-02',
  [HttpStatus.NOT_FOUND]: 'E-NOT-01',
  [HttpStatus.CONFLICT]: 'E-VER-01',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'E-LIM-01',
  [HttpStatus.TOO_MANY_REQUESTS]: 'E-RATE-01',
  [HttpStatus.NOT_IMPLEMENTED]: 'E-NOT-01',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'E-SRV-02',
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<AppRequest>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'E-SRV-01';
    let message = 'Внутренняя ошибка сервера';
    let fields: Record<string, string> | undefined;

    if (exception instanceof DomainError) {
      status = exception.httpStatus;
      code = exception.code;
      message = exception.message;
      fields = exception.fields;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const record = body as {
          message?: string | string[];
          code?: string;
          fields?: Record<string, string>;
        };
        message = Array.isArray(record.message)
          ? record.message.join('; ')
          : (record.message ?? exception.message);
        code = record.code ?? STATUS_TO_CODE[status] ?? code;
        fields = record.fields;
      } else {
        message = exception.message;
        code = STATUS_TO_CODE[status] ?? code;
      }
    } else if (exception instanceof Error) {
      this.logger.error(
        `${request.method} ${request.url} ${status} request_id=${request.requestId}`,
        exception.stack,
      );
    }

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} ${status} request_id=${request.requestId}`,
      );
    }

    response.status(status).json({
      error: {
        code,
        message,
        ...(fields ? { fields } : {}),
        request_id: request.requestId,
      },
    });
  }
}
