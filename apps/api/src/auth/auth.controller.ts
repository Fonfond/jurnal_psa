import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  loginSchema,
  oidcAuthorizeQuerySchema,
  oidcCallbackQuerySchema,
  type AuthConfigResponse,
  type LoginInput,
} from '@logbook/shared';
import type { Response } from 'express';
import { loadEnv } from '../config/env';
import { CurrentUser } from '../common/current-user.decorator';
import { Public } from '../common/public.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AppRequest, AuthUser } from '../common/types';
import { AuthService } from './auth.service';
import {
  CSRF_COOKIE,
  OIDC_STATE_COOKIE,
  OIDC_STATE_COOKIE_PATH,
  SESSION_COOKIE,
} from './auth.constants';

@Controller()
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /** Public auth metadata for the SPA (no secrets). */
  @Public()
  @Get('auth/config')
  config(): AuthConfigResponse {
    return this.auth.getAuthConfig();
  }

  @Public()
  @Post('auth/dev-login')
  @HttpCode(HttpStatus.OK)
  async devLogin(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Req() request: AppRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    const result = await this.auth.devLogin(
      body.email,
      body.password,
      request.header('user-agent'),
      request.ip,
      body.device_id,
    );

    this.setAuthCookies(response, result.session.token, result.csrfToken);

    return {
      auth_provider: 'dev',
      user: result.profile,
      session: {
        offline_valid_until: result.session.expiresAt,
        refresh_expires_at: result.session.expiresAt,
        device_id: result.session.deviceId,
      },
      csrf_token: result.csrfToken,
    };
  }

  /**
   * Starts OIDC Authorization Code + PKCE (ADR-23). Redirects to the IdP and
   * stores the single-use state in an HttpOnly cookie bound to the transaction.
   */
  @Public()
  @Get('auth/authorize')
  async authorize(
    @Query(new ZodValidationPipe(oidcAuthorizeQuerySchema))
    query: { redirect_after?: string; device_id?: string },
    @Req() request: AppRequest,
    @Res() response: Response,
  ): Promise<void> {
    const env = loadEnv();
    const result = await this.auth.beginOidcLogin({
      redirectAfter: query.redirect_after,
      deviceId: query.device_id,
      userAgent: request.header('user-agent'),
      ip: request.ip,
    });

    response.cookie(OIDC_STATE_COOKIE, result.stateCookieValue, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
      maxAge: result.maxAgeSeconds * 1000,
      path: OIDC_STATE_COOKIE_PATH,
    });
    response.redirect(HttpStatus.FOUND, result.url);
  }

  /**
   * OIDC callback. Success establishes the session cookie and redirects to the
   * SPA; failures redirect to the login screen with a machine-readable code.
   */
  @Public()
  @Get('auth/callback')
  async callback(
    @Query(new ZodValidationPipe(oidcCallbackQuerySchema))
    query: {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    },
    @Req() request: AppRequest,
    @Res() response: Response,
  ): Promise<void> {
    const stateCookie = request.cookies?.[OIDC_STATE_COOKIE] as string | undefined;
    try {
      const result = await this.auth.completeOidcLogin(
        {
          code: query.code,
          state: query.state,
          stateCookie,
          error: query.error,
          errorDescription: query.error_description,
        },
        request.header('user-agent'),
        request.ip,
      );

      this.setAuthCookies(response, result.session.token, result.csrfToken);
      response.clearCookie(OIDC_STATE_COOKIE, {
        path: OIDC_STATE_COOKIE_PATH,
      });
      response.redirect(HttpStatus.FOUND, result.redirectAfter);
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error
          ? String((error as { code: unknown }).code)
          : 'E-OIDC-02';
      const message = error instanceof Error ? error.message : 'Ошибка входа';
      const params = new URLSearchParams({ auth_error: code, message });
      response.clearCookie(OIDC_STATE_COOKIE, {
        path: OIDC_STATE_COOKIE_PATH,
      });
      response.redirect(HttpStatus.FOUND, `/login?${params.toString()}`);
    }
  }

  @Post('auth/session')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @CurrentUser() user: AuthUser,
  ): Promise<Record<string, unknown>> {
    const profile = await this.auth.getProfile(user.id);
    return {
      user: profile,
      session: {
        offline_valid_until: user.sessionExpiresAt,
        refresh_expires_at: user.sessionExpiresAt,
      },
    };
  }

  @Post('auth/logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ ok: true }> {
    await this.auth.logout(user.sessionId);
    response.clearCookie(SESSION_COOKIE, { path: '/' });
    response.clearCookie(CSRF_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  async me(
    @CurrentUser() user: AuthUser,
    @Req() request: AppRequest,
  ): Promise<Record<string, unknown>> {
    const profile = await this.auth.getProfile(user.id);
    const authConfig = this.auth.getAuthConfig();
    // ADR-16/SYN-02: the offline supervisor cache is enabled for the roles
    // that review the department journal (client keeps 7 days per journal).
    const supervisorCache =
      user.role === 'supervisor' || user.role === 'admin';
    // The admin SPA runs on a separate origin (ADR-14) and cannot read the
    // CSRF cookie of the API origin; return the token with the profile.
    const csrfToken =
      (request as AppRequest & { cookies?: Record<string, string> }).cookies?.[
        CSRF_COOKIE
      ] ?? null;
    return {
      user: profile,
      session: {
        offline_valid_until: user.sessionExpiresAt,
        refresh_expires_at: user.sessionExpiresAt,
      },
      csrf_token: csrfToken,
      auth: {
        provider: authConfig.auth_provider,
      },
      signature: authConfig.signature,
      features: {
        voice: false, // TODO(G1)
        web_speech: false, // TODO(OQ-10)
        attachments: false,
        supervisor_cache: supervisorCache,
        device_registration: true,
      },
    };
  }

  private setAuthCookies(
    response: Response,
    token: string,
    csrfToken: string,
  ): void {
    const env = loadEnv();
    const maxAge = env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
    const secure = env.NODE_ENV === 'production';

    response.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge,
      path: '/',
    });
    response.cookie(CSRF_COOKIE, csrfToken, {
      httpOnly: false,
      sameSite: 'lax',
      secure,
      maxAge,
      path: '/',
    });
  }
}
