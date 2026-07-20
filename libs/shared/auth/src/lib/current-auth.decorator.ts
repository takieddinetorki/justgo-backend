import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { authFromRequest } from './auth-context';

/** Controller param decorator: `me(@CurrentAuth() auth: AuthContext)` */
export const CurrentAuth = createParamDecorator((_data: unknown, ctx: ExecutionContext) =>
  authFromRequest(ctx.switchToHttp().getRequest<Record<string, unknown>>()),
);
