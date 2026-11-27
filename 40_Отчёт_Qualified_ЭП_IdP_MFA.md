# Отчёт: qualified ЭП и OIDC IdP/MFA harness (REP-01, REP-02)

| Параметр | Значение |
|---|---|
| Задача | t25 (REP-01 + REP-02) |
| Статус | Контракты и harness реализованы и проверены; реальные КЭП/IdP — **внешние блокеры** (OQ-02/OQ-04), mock не выдаётся за production |
| Дата | 27.11.2026 |
| Проверки | typecheck 0; `npm test` — **298** (shared 28 / API 117 / web 153); build ok |
| Документы | `docs/security/QUALIFIED_ES_CONTRACT.md`, `docs/security/OIDC_INTEGRATION.md`, `docs/security/REP-01_02_WAIVER.md` |

---

## 1. Итог

| Требование | Результат |
|---|---|
| REP-01: qualified adapter — проверяемый контракт sign/verify/error/timeout с тестовым провайдером | ✅ HTTP-контракт v1 + тестовый HTTP-провайдер; 5 тестов: sign/verify, tamper, HTTP 503, invalid JSON, timeout; интеграция API (ручная подпись, verify, подмена → invalid, `E-SIG-02` при недоступном КЭП) |
| REP-02: harness реального OIDC IdP с MFA для admin и redirect URI | ✅ `OidcTestIdp` по реальному HTTP (discovery/authorize/token/JWKS/userinfo), PKCE S256, state/nonce, точный redirect URI, MFA (`acr=mfa`, `amr=pwd+otp`), 4 интеграционных теста |
| MFA администратора (NFR-SEC-02) | ✅ `OIDC_REQUIRE_MFA_FOR_ADMIN=true` (production-гейт), `OIDC_MFA_ACR_VALUES`; без второго фактора admin получает `E-OIDC-04`, сессия не создаётся |
| Redirect URI | ✅ `OIDC_REDIRECT_URI` проверяется IdP точно в `/authorize` и `/token`; harness отклоняет несовпадение; state привязан к HttpOnly cookie |
| Не выдавать mock за production | ✅ тестовые IdP/КЭП только в `apps/api/test/**`, не входят в production-сборку; подписанный blocker/waiver `REP-01_02_WAIVER.md` |
| Production env fail-closed | ✅ production требует OIDC/MFA, DATABASE_URL, секреты, TLS; dev-login запрещён |
| Тесты и docs | ✅ 9 новых тестов (5 + 4) + env-gate; отчёт, 35 (changelog 1.3), RUNBOOK, `.env.example`, контракты |

---

## 2. Qualified ЭП: контракт и адаптер

Реализация: `apps/api/src/signature/qualified.provider.ts`,
`docs/security/QUALIFIED_ES_CONTRACT.md`.

- `POST <SIGNATURE_QUALIFIED_ENDPOINT>` с `Authorization: Bearer
  <SIGNATURE_QUALIFIED_TOKEN>`, JSON `{operation,entity_type,entity_id,
  entity_version,content_hash,signer_id,...}`.
- Sign: `{signature, algorithm, key_id, certificate_serial, certificate_subject,
  metadata}`; обязателен непустой `signature`.
- Verify: `{valid:boolean, reason?}`; `false` переводит подпись в `invalid` и
  аудитируется.
- Ошибки fail-closed: сеть/таймаут (`SIGNATURE_QUALIFIED_TIMEOUT_MS`),
  HTTP ≠2xx, невалидный JSON, отсутствие `signature`/`valid` → `E-SIG-02` (501).
- `SIGNATURE_PROVIDER=qualified` без endpoint/token не стартует (env-гейт).
- Авто-подпись для `qualified` **не выполняется** (только `simple` — in-process);
  подпись — ручные `POST /entries/:id/sign` и `/journal/reviews/:id/sign`.
- Тестовый HTTP-провайдер: `apps/api/test/helpers/qualified-esp-test-provider.ts`
  (режимы успех/tamper/HTTP 503/invalid JSON/delay); **не КЭП**, не для production.

Тесты `qualified-signature.spec.ts` (5/5):

1. sign/verify через контракт, проверка Bearer и метаданных сертификата;
2. tamper `content_hash` → `valid=false` с reason;
3. HTTP 503 → `SignatureProviderError` (`E-SIG-02` в API);
4. invalid JSON → fail-closed;
5. timeout (задержка 300 мс, таймаут 50 мс) → fail-closed.

Интеграция API: verify не создаёт подпись автоматически; ручной sign даёт
`kind=qualified`, `certificate_serial/subject`, verify=true; подмена текста →
verify=false + `status=invalid`; недоступный КЭП → `501 E-SIG-02`.

## 3. OIDC IdP/MFA harness

Реализация: `apps/api/test/helpers/oidc-test-idp.ts`,
`docs/security/OIDC_INTEGRATION.md`.

Harness — HTTP-сервер (не fetch-мок):

- `GET /.well-known/openid-configuration`, `GET /jwks`, `POST /token`,
  `GET /userinfo`, `GET /authorize` (Authorization Code + PKCE S256);
- точная проверка `client_id`, `client_secret`, `redirect_uri`, PKCE,
  одноразового `code`; подпись `id_token` RS256, `nonce`, `acr`/`amr`;
- профили: `admin@logbook.local` с MFA (`acr=mfa`, `amr=['pwd','otp']`) и
  `worker@logbook.local` без MFA; форма логина для ручного сценария;
- `acr_values` из API (`OIDC_MFA_ACR_VALUES`) сохраняется и проверяется тестом.

MFA enforcement (`AuthService.assertAdminMfa`):

- роль определяется по `user_identities (issuer,sub)` или подтверждённому email;
- для `admin` при `OIDC_REQUIRE_MFA_FOR_ADMIN=true` требуется `acr` ∈
  `OIDC_MFA_ACR_VALUES` или `amr` ∈ `mfa|otp|hwk|swk|totp|pwd+mfa`;
- иначе — `E-OIDC-04` (403), callback → `/login?auth_error=E-OIDC-04`, сессии нет;
- production-гейт: `OIDC_REQUIRE_MFA_FOR_ADMIN=false` отклоняется.

Тесты `auth-oidc-real-idp.spec.ts` (4/4):

1. admin + MFA → вход, `/me` admin, точный `redirect_uri`, `acr_values=mfa`, PKCE;
2. admin без MFA → `E-OIDC-04`, без сессии;
3. worker без MFA → успешный вход;
4. token endpoint 503 → `E-OIDC-02`, без сессии.

Существующие `auth-oidc.spec` (replay state, cookie mismatch, неизвестный
пользователь, подпись/claims) и `auth-platform.spec` (env-гейты, dev-login в
production) остаются зелёными.

## 4. Production env и dev-login

- production: `AUTH_PROVIDER=oidc`, `DEV_LOGIN_ENABLED=false`, `OIDC_*`,
  `OIDC_REQUIRE_MFA_FOR_ADMIN=true`, `OIDC_MFA_ACR_VALUES`, `DATABASE_URL`,
  TLS к БД, секреты, https-origins, ЭП-fail-closed.
- dev-login запрещён по провайдеру и в production (`E-AUTH-02`); тесты
  подтверждают. `OIDC_JIT_PROVISION` по умолчанию false (нет саморегистрации).

## 5. Внешние блокеры и waiver

`docs/security/REP-01_02_WAIVER.md` (подписан владельцем ИБ):

| Блокер | Влияние |
|---|---|
| Нет аккредитованного сервиса КЭП/УЦ и сертификатов (OQ-04) | `qualified` нельзя включать в production; юридическая значимость не подтверждена |
| Нет реального OIDC IdP, client credentials, MFA-политики и redirect URI (OQ-02) | production-вход заблокирован, используется dev-провайдер только локально |
| Нет маппинга групп IdP → роли Logbook | роли назначает администратор Logbook |

Тестовые IdP/КЭП находятся только в тестах, не входят в production-артефакт;
в отчётах/доках они явно названы mock-провайдерами. До снятия блокеров
production readiness в этой части не заявляется.

## 6. Проверки

| Команда | Результат |
|---|---|
| `npm run typecheck` | 0 |
| `npm test` | 298 passed: shared 28, API 117 (20 suites), web 153 |
| `jest qualified-signature.spec.ts` | 5/5 |
| `jest auth-oidc-real-idp.spec.ts` | 4/4 |
| `npm run build` | shared + API + web ok |

## 7. Остаточные риски

1. Реальный КЭП-провайдер не проверен: формат CMS, сертификаты, статусы
   отзыва, регламент УЦ — после OQ-04.
2. Реальный IdP не подключён: discovery/JWKS/acr-claims и MFA-политика могут
   отличаться; harness покрывает стандартный профиль, но не особенности IdP.
3. Маппинг ролей идёт по email/sup, а не по группам IdP; смена email требует
   администрирования.
4. Тестовый IdP не проверяет пароли/MFA-факторы — это harness, не IdP.
5. Юридическая значимость `simple`/`qualified` до OQ-04 не подтверждена;
   `simple` остаётся HMAC сервера, не КЭП.

## 8. Изменённые файлы

- `apps/api/src/auth/auth.service.ts` (MFA), `auth/providers/oidc-identity.provider.ts`
  (`acr_values`), `apps/api/src/config/env.ts` (MFA env/гейт),
  `packages/shared/src/errors.ts` (`E-OIDC-04`),
  `apps/api/src/signature/signature.service.ts` (auto-sign только simple);
- `apps/api/test/helpers/qualified-esp-test-provider.ts`,
  `apps/api/test/helpers/oidc-test-idp.ts`,
  `apps/api/test/qualified-signature.spec.ts`,
  `apps/api/test/auth-oidc-real-idp.spec.ts`,
  `apps/api/test/auth-platform.spec.ts`;
- `docs/security/{QUALIFIED_ES_CONTRACT,OIDC_INTEGRATION,REP-01_02_WAIVER}.md`;
- `40_Отчёт_Qualified_ЭП_IdP_MFA.md`, `35_Руководство_по_установке.md`,
  `RUNBOOK.md`, `.env.example`.
