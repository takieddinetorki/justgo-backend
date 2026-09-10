import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RbacGuard } from './rbac.guard';
import { JoseTokenVerifier, TOKEN_VERIFIER, type JwtVerifierOptions } from './jwt-verifier';
import {
  JoseTokenSigner,
  TOKEN_SIGNER,
  UnavailableTokenSigner,
  type TokenSigner,
} from './jwt-signer';

export interface AuthModuleOptions {
  /** Omit to run without a verifier (all non-@Public routes reject 401). */
  jwt?: JwtVerifierOptions;
  /** Register RbacGuard globally (default true). */
  globalGuard?: boolean;
}

/**
 * We can only mint tokens the verifier will accept if we hold the key it
 * checks against — i.e. the HS256 shared secret. Under JWKS the API holds
 * only public keys, so issuance is refused explicitly rather than
 * producing a token that fails on its first use.
 */
function makeSigner(jwt: JwtVerifierOptions | undefined): TokenSigner {
  if (!jwt?.secret) return new UnavailableTokenSigner();
  return new JoseTokenSigner({
    secret: jwt.secret,
    issuer: jwt.issuer,
    audience: jwt.audience,
  });
}

@Module({})
export class AuthModule {
  static forRoot(options: AuthModuleOptions = {}): DynamicModule {
    const providers = [
      {
        provide: TOKEN_VERIFIER,
        useValue: options.jwt ? new JoseTokenVerifier(options.jwt) : null,
      },
      { provide: TOKEN_SIGNER, useValue: makeSigner(options.jwt) },
      RbacGuard,
      ...(options.globalGuard === false ? [] : [{ provide: APP_GUARD, useClass: RbacGuard }]),
    ];
    return {
      module: AuthModule,
      global: true,
      providers,
      exports: [TOKEN_VERIFIER, TOKEN_SIGNER, RbacGuard],
    };
  }
}
