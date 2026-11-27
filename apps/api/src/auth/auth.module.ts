import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from '../audit/audit.module';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { CsrfGuard } from './csrf.guard';
import { DevIdentityProvider } from './providers/dev-identity.provider';
import { OidcIdentityProvider } from './providers/oidc-identity.provider';
import { RolesGuard } from './roles.guard';

@Module({
  imports: [AuditModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    DevIdentityProvider,
    OidcIdentityProvider,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService, OidcIdentityProvider],
})
export class AuthModule {}
