import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { trace } from '@opentelemetry/api';
import { AppError } from '@justgo/kernel';

/**
 * Every error leaves the API in the §17.3 envelope:
 * { error: { code, message, details }, traceId }
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const traceId = trace.getActiveSpan()?.spanContext().traceId;

    if (exception instanceof AppError) {
      response.status(exception.httpStatus).json(exception.toEnvelope(traceId));
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'string'
          ? body
          : ((body as { message?: string | string[] }).message ?? exception.message);
      response.status(status).json({
        error: {
          code: httpStatusToCode(status),
          message: Array.isArray(message) ? message.join('; ') : message,
          details: {},
        },
        traceId,
      });
      return;
    }

    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'INTERNAL', message: 'Internal server error', details: {} },
      traceId,
    });
  }
}

function httpStatusToCode(status: number): string {
  switch (status) {
    case 400:
      return 'VALIDATION_FAILED';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'BUSINESS_RULE_VIOLATED';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'INTERNAL';
  }
}
