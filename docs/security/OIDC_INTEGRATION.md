# OIDC: интеграционный harness реального IdP и MFA администратора

| Параметр | Значение |
|---|---|
| Документ | OIDC-INTEGRATION-HARNESS v1 |
| Область | `apps/api/src/auth/**`, `apps/api/test/helpers/oidc-test-idp.ts`, `auth-oidc-real-idp.spec.ts` |
| Статус | Harness проверен по реальному HTTP (discovery/authorize/token/JWKS/userinfo); **реальный IdP заказчика не подключён** (OQ-02, внешние credentials) |
| Связано | OQ-02, REP-02, NFR-SEC-02, ADR-23 |

## 1. Что проверяет harness

`OidcTestIdp` — тестовый OIDC-провайдер, работающий по HTTP (не `fetch`-мок):

- `GET /.well-known/openid-configuration` — discovery;
- `GET /authorize` — Authorization Code + PKCE S256, `state`/`nonce`, `acr_values`
  (при отсутствии `login` возвращает форму для ручного сценария);
- `POST /token` — проверка `client_id`/`client_secret`, `redirect_uri`, PKCE
  (`code_verifier` → S256), одноразовый `code`;
- `GET /jwks` — RSA-ключ, подпись `id_token` RS256;
- `GET /userinfo` — fallback email.

Профили пользователей: `admin@logbook.local` (MFA: `acr=mfa`, `amr=['pwd','otp']`)
и `worker@logbook.local` (без MFA). `sub` стабилен для связки `user_identities`.

## 2. Redirect URI

- В API: `OIDC_REDIRECT_URI` — **точный** `https://<origin>/v1/auth/callback`
  (в тесте `http://localhost:3100/v1/auth/callback`).
- IdP обязан валидировать точное совпадение `redirect_uri` в `/authorize` и
  `/token`; harness это делает и возвращает `invalid_grant` при несовпадении.
- `state` дополнительно привязан к HttpOnly cookie `lb_oidc_state` (path `/v1/auth`,
  TTL 10 минут); login-транзакция одноразовая (`oidc_login_requests.consumed_at`).
- `redirect_after` — только same-origin путь (`/` по умолчанию).

## 3. MFA администратора (NFR-SEC-02)

- В authorize отправляется `acr_values` из `OIDC_MFA_ACR_VALUES` (по умолчанию `mfa`).
- После проверки `id_token` и определения роли (связка `sub`, затем подтверждённый
  email) `AuthService.assertAdminMfa` требует:
  - `acr` ∈ `OIDC_MFA_ACR_VALUES`, **или**
  - `amr` содержит один из `mfa|otp|hwk|swk|totp|pwd+mfa`.
- Если для `role=admin` второго фактора нет — `E-OIDC-04` (403), сессия не создаётся,
  callback редиректит на `/login?auth_error=E-OIDC-04`.
- Production-гейт `OIDC_REQUIRE_MFA_FOR_ADMIN=true` обязателен (`env.ts`).
- MFA для worker/supervisor не блокируется (политика IdP), но `acr_values`
  запрашивается всегда.

## 4. Интеграционные тесты

`apps/api/test/auth-oidc-real-idp.spec.ts` (PGlite + Nest + реальный HTTP IdP):

1. admin + MFA → callback `/`, `/me` admin, проверены точный `redirect_uri`,
   `acr_values=mfa`, PKCE challenge;
2. admin без MFA → `/login?auth_error=E-OIDC-04`, сессии нет;
3. worker без MFA → успешный вход;
4. ошибка token endpoint (503) → `/login?auth_error=E-OIDC-02`, сессии нет.

Дополнительно `auth-oidc.spec.ts` проверяет replay state, несовпадение cookie,
непровиженного пользователя и подпись `id_token` (tamper/nonce/aud/exp/alg).

## 5. Конфигурация production

```env
AUTH_PROVIDER=oidc
DEV_LOGIN_ENABLED=false
OIDC_ISSUER=https://idp.example.com/realms/logbook
OIDC_CLIENT_ID=logbook
OIDC_CLIENT_SECRET=<secret>
OIDC_REDIRECT_URI=https://logbook.example.com/v1/auth/callback
OIDC_ALLOWED_ALGORITHMS=RS256
OIDC_REQUIRE_MFA_FOR_ADMIN=true
OIDC_MFA_ACR_VALUES=mfa
OIDC_JIT_PROVISION=false
```

Требования к IdP: Authorization Code + PKCE S256, RS256 (или разрешённый алгоритм),
JWKS, `acr`/`amr` для администраторов, точная регистрация redirect URI, MFA-политика
для роли admin. Реальные метаданные discovery, client credentials и redirect URI
предоставляет ИТ/ИБ заказчика (OQ-02).

## 6. Ограничения и блокеры

- Harness — **mock, не production IdP**: он не проверяет пароли, не реализует
  MFA-факторы и не является доверенным источником идентичности.
- Реальный IdP, MFA-политика и credentials не предоставлены (OQ-02) — блокер
  production-входа; до этого используется dev-провайдер локально.
- Маппинг ролей берётся из provisioned-пользователя Logbook (email), а не из
  групп IdP; автоматическое управление ролями через claims — отдельная задача.
- JIT-провижининг по умолчанию выключен (самостоятельная регистрация запрещена).
- Ошибки/таймауты IdP не раскрывают детали клиенту (код `E-OIDC-01/02/03/04`),
  подробности — в логах/аудите.
