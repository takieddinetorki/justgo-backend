/**
 * Error taxonomy mapping 1:1 to the API error envelope (§17.3).
 * `code` is a stable machine code; clients localize messages from it.
 */
export abstract class AppError extends Error {
  abstract readonly httpStatus: number;
  readonly details: Record<string, unknown>;

  protected constructor(
    readonly code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }

  toEnvelope(traceId?: string): {
    error: { code: string; message: string; details: Record<string, unknown> };
    traceId?: string;
  } {
    return { error: { code: this.code, message: this.message, details: this.details }, traceId };
  }
}

/** 400 — malformed input rejected at the edge. */
export class ValidationError extends AppError {
  readonly httpStatus = 400;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('VALIDATION_FAILED', message, details);
  }
}

/** 401 */
export class UnauthenticatedError extends AppError {
  readonly httpStatus = 401;
  constructor(message = 'Authentication required') {
    super('UNAUTHENTICATED', message);
  }
}

/** 403 */
export class ForbiddenError extends AppError {
  readonly httpStatus = 403;
  constructor(message = 'Not allowed', details: Record<string, unknown> = {}) {
    super('FORBIDDEN', message, details);
  }
}

/** 404 */
export class NotFoundError extends AppError {
  readonly httpStatus = 404;
  constructor(resource: string, id?: string) {
    super('NOT_FOUND', `${resource} not found`, id ? { id } : {});
  }
}

/** 409 — conflicts and illegal state-machine transitions (§8). */
export class ConflictError extends AppError {
  readonly httpStatus = 409;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
  }
}

/** 422 — a well-formed request that violates a business rule. */
export class BusinessRuleError extends AppError {
  readonly httpStatus = 422;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
  }
}
