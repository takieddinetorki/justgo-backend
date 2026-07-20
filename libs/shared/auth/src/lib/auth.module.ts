import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RbacGuard } from './rbac.guard';
import { JoseTokenVerifier, TOKEN_VERIFIER, type JwtVerifierOptions } from './jwt-verifier';

export interface AuthModuleOptions {
  /** Omit to run without a verifier (all non-@Public routes reject 401). */
  jwt?: JwtVerifierOptions;
  /** Register RbacGuard globally (default true). */
  globalGuard?: boolean;
}

@Module({})
export class AuthModule {
  static forRoot(options: AuthModuleOptions = {}): DynamicModule {
    const providers = [
      {
        provide: TOKEN_VERIFIER,
        useValue: options.jwt ? new JoseTokenVerifier(options.jwt) : null,
      },
      RbacGuard,
      ...(options.globalGuard === false ? [] : [{ provide: APP_GUARD, useClass: RbacGuard }]),
    ];
    return {
      module: AuthModule,
      global: true,
      providers,
      exports: [TOKEN_VERIFIER, RbacGuard],
    };
  }
}
