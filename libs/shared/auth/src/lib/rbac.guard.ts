import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Optional,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError, UnauthenticatedError } from '@justgo/kernel';
import { AUTH_CONTEXT, hasPermission, type AuthContext } from './auth-context';
import { TOKEN_VERIFIER, type TokenVerifier } from './jwt-verifier';

export const PERMISSIONS_KEY = 'required_permissions';
export const PUBLIC_KEY = 'is_public';

/** Route decorator: permission keys are data-driven (§11), e.g. 'request.create'. */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Route decorator: skip authentication entirely (health checks etc.). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  [AUTH_CONTEXT]?: AuthContext;
}

/**
 * Verifies the bearer token, attaches AuthContext to the request, and
 * enforces @RequirePermissions. RLS remains the second line of defense.
 */
@Injectable()
export class RbacGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional() @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier | null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    if (!this.verifier) {
      throw new UnauthenticatedError('Authentication is not configured');
    }

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers['authorization'];
    const raw = Array.isArray(header) ? header[0] : header;
    if (!raw?.startsWith('Bearer ')) {
      throw new UnauthenticatedError('Missing bearer token');
    }

    const ctx = await this.verifier.verify(raw.slice('Bearer '.length));
    request[AUTH_CONTEXT] = ctx;

    const required =
      this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    const missing = required.filter((p) => !hasPermission(ctx, p));
    if (missing.length > 0) {
      throw new ForbiddenError('Missing permission', { required: missing });
    }
    return true;
  }
}
