# Отчёт: auth-platform (OIDC, устройства, абстракция ЭП)

| Параметр | Значение |
|---|---|
| Задача | t2 [auth-platform] |
| Статус | Выполнено: OIDC/PKCE, регистрация устройств, абстракция ЭП, production-конфигурация, миграция 0007, тесты |
| Дата | 24.11.2026 |
| Затрагивает | `apps/api`, `apps/web`, `packages/shared`, `db/migrations`, `.env.example`, `RUNBOOK.md` |
| Связанные решения | ADR-22 (dev-провайдер), ADR-23 (OIDC + регистрация устройств), ADR-25 (абстракция ЭП), OQ-02, OQ-04 |

---

## 1. Итог

После журнального слоя (отчёт 23) аутентификация была dev-only: `/v1/auth/authorize` и
`/v1/auth/callback` возвращали `501`, устройство нельзя было зарегистрировать, а визы
подтверждались только сессией. Закрыто:

1. **OIDC Authorization Code + PKCE** — полноценный провайдер (`AUTH_PROVIDER=oidc`) с
   discovery, PKCE (S256), `state`/`nonce`, проверкой подписи `id_token` по JWKS,
   привязкой `state` к браузеру через HttpOnly cookie, одноразовыми login-транзакциями в БД.
2. **Dev-провайдер сохранён** для локального запуска и тестов (`AUTH_PROVIDER=dev`),
   принудительно выключен в production и при `DEV_LOGIN_ENABLED=false`.
3. **Регистрация устройств** — `POST /v1/devices` (идемпотентно по `install_id`),
   одноразовая выдача `device_key`, привязка ключа к push-синхронизации, привязка сессии
   к устройству, каскадный отзыв сессий при отзыве устройства.
4. **Абстракция ЭП** — интерфейс `SignatureProvider` и адаптеры `simple` (HMAC-SHA256
   сервера), `qualified` (внешний сервис КЭП), `none` (MVP без ЭП). Подписи виз и
   проверок журнала, идемпотентность, проверка целостности, аудит, юридическая оговорка.
5. **Production-конфигурация** — fail-closed валидация окружения: production требует
   OIDC, собственный `COOKIE_SECRET`, выключенный dev-вход; `simple`/`qualified` требуют
   секретов/endpoint; `https`-требования к issuer и redirect URI.
6. **Миграция 0007** — `user_identities`, `oidc_login_requests`, поля устройств/сессий,
   `document_signatures`.
7. **Тесты** — 2 новых набора API (20 тестов: env, PKCE/JWT, OIDC e2e с подменённым IdP,
   устройства, ЭП) и обновлённые web-тесты (SSO-вход, регистрация устройства в sync).
   Итог по репозиторию: 123 теста (shared 25, API 63, web 35), `typecheck` и `build` — зелёные.

Журнальный слой и dev-сценарии не сломаны: seed-устройства без ключа работают как
раньше (обратная совместимость), dev-login остаётся для локального запуска.

---

## 2. Архитектура и файлы

| Слой | Файлы |
|---|---|
| Провайдеры аутентификации | `apps/api/src/auth/identity-provider.ts`, `auth/providers/dev-identity.provider.ts`, `auth/providers/oidc-identity.provider.ts` |
| OIDC-примитивы | `apps/api/src/auth/oidc/pkce.ts`, `auth/oidc/jwt.ts`, `auth/oidc/oidc-client.ts` |
| Auth API | `apps/api/src/auth/auth.service.ts`, `auth.controller.ts`, `auth.module.ts`, `auth.constants.ts` |
| Устройства | `apps/api/src/devices/devices.controller.ts`, `devices.service.ts`, `devices.module.ts` |
| ЭП | `apps/api/src/signature/signature.provider.ts`, `simple.provider.ts`, `qualified.provider.ts`, `factory.ts`, `signature.service.ts`, `signature.controller.ts`, `signature.module.ts`, `signature.constants.ts`, `content-hash.ts` |
| Интеграция виз/проверок | `apps/api/src/journal/journal.service.ts`, `journal.controller.ts`, `journal.module.ts` |
| Конфигурация | `apps/api/src/config/env.ts` |
| Миграция | `db/migrations/0007_auth_platform.sql` |
| Общие типы/схемы | `packages/shared/src/types.ts`, `schemas.ts`, `errors.ts` |
| Web | `apps/web/src/api/client.ts`, `api/types.ts`, `sync/engine.ts`, `db/repositories.ts`, `screens/LoginScreen.tsx` |

### 2.1. Провайдеры

`IdentityProvider` — шов замены способа входа:

- `DevIdentityProvider` (ADR-22) — email + bcrypt-пароль из `user_credentials`, только
  вне production и только при `AUTH_PROVIDER=dev`;
- `OidcIdentityProvider` (ADR-23) — редиректный вход; хранит login-транзакцию
  (`state_hash`, `nonce`, `code_verifier`) в `oidc_login_requests` и связывает её с
  браузером cookie `lb_oidc_state` (HttpOnly, SameSite=Lax, TTL 10 минут, path `/v1/auth`).

### 2.2. Поток OIDC

1. `GET /v1/auth/authorize?redirect_after=/` → discovery IdP, генерация `state`, `nonce`,
   `code_verifier` (43–128 симв.), `code_challenge = S256(verifier)`; запись транзакции в
   БД; cookie `lb_oidc_state` = `state`; `302` на IdP.
2. IdP возвращает `GET /v1/auth/callback?code&state`.
3. Сервер проверяет cookie ↔ `state` (constant-time), находит неистёкшую и не
   использованную транзакцию и помечает её использованной **до** обмена кода.
4. Обмен `code` → `id_token` (+`access_token`) на `token_endpoint` с `code_verifier`;
   `client_secret` — basic/post по метаданным IdP.
5. Проверка `id_token`: подпись по JWKS (RS/PS/ES/EdDSA, разрешённые алгоритмы из
   `OIDC_ALLOWED_ALGORITHMS`), `iss`, `aud`, `exp`/`iat`/`nbf` с часовым сдвигом,
   `nonce`; при отсутствии email — `userinfo`.
6. Сопоставление пользователя (см. 2.3), сессия (opaque token в HttpOnly cookie), CSRF,
   редирект на `redirect_after` (только same-origin путь).
7. Ошибка → `302 /login?auth_error=<code>&message=...`; SPA показывает сообщение.

### 2.3. Сопоставление пользователя (FR-AUTH-01: без самостоятельной регистрации)

1. Существующая связка `user_identities (issuer, subject)` → вход.
2. Иначе — пользователь с совпадающим **подтверждённым** email (`email_verified` не
   `false`) → привязка identity + аудит `user.oidc_link`.
3. Иначе — при `OIDC_JIT_PROVISION=true` и заданном `OIDC_JIT_DEPARTMENT_ID` создаётся
   пользователь (роль `OIDC_JIT_ROLE`, по умолчанию `worker`) + аудит `user.provision_oidc`.
4. Иначе — `403 E-OIDC-03` «Учётная запись не найдена. Обратитесь к администратору».

По умолчанию JIT выключен: учётные записи создаёт администратор.

---

## 3. API

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/v1/auth/config` | публично: провайдер, dev-login флаг, имя IdP, режим ЭП |
| `GET` | `/v1/auth/authorize` | старт OIDC + PKCE, `302` на IdP |
| `GET` | `/v1/auth/callback` | callback IdP, установка сессии, `302` в SPA |
| `POST` | `/v1/auth/dev-login` | dev-вход (`device_id` опционален) |
| `GET` | `/v1/devices` | устройства пользователя (`install_id`, `device_key_set`, `revoked_at`) |
| `POST` | `/v1/devices` | регистрация/обновление устройства по `install_id`; `201` |
| `DELETE` | `/v1/devices/{id}` | отзыв устройства + его сессий |
| `POST` | `/v1/entries/{id}/verify` | виза; при `SIGNATURE_AUTO_SIGN` возвращает `signature` |
| `POST` | `/v1/entries/{id}/sign` | ручная подпись визы (supervisor/admin) |
| `GET` | `/v1/entries/{id}` | запись + `revisions` + `signatures` |
| `POST` | `/v1/journal/reviews` | проверка журнала; при auto-sign возвращает `signature` |
| `POST` | `/v1/journal/reviews/{id}/sign` | ручная подпись проверки (автор/admin) |
| `GET` | `/v1/journal/reviews/{id}/signatures` | подписи проверки (supervisor/admin/auditor) |
| `GET` | `/v1/signature/info` | провайдер ЭП, алгоритм, auto-sign, юридическая оговорка |
| `POST` | `/v1/signature/{id}/verify` | проверка подписи по актуальному содержимому |

Новые коды ошибок (`packages/shared/src/errors.ts`):

| Код | HTTP | Значение |
|---|---|---|
| `E-OIDC-01` | 400 | некорректный state/code/callback, `id_token` отклонён |
| `E-OIDC-02` | 502 | IdP недоступен, discovery/token/JWKS не получены |
| `E-OIDC-03` | 403 | пользователь не provisioned (нет самостоятельной регистрации) |
| `E-SIG-01` | 422 | некорректная подпись/данные подписи |
| `E-SIG-02` | 501 | провайдер ЭП не настроен / сервис КЭП недоступен |

Синхронизация: `POST /v1/sync/push` для устройства с ключом требует заголовок
`X-Device-Key` (сравнение constant-time); отозванное устройство получает `403`.
Устройства, созданные до 0007 (seed и старый клиент), ключа не имеют — для них
поведение прежнее.

---

## 4. Конфигурация

### 4.1. Переменные

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `AUTH_PROVIDER` | `dev` / `oidc` | `dev` |
| `DEV_LOGIN_ENABLED` | выключатель dev-входа | `true` |
| `OIDC_ISSUER` | issuer IdP (https) | — |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | регистрация клиента | — |
| `OIDC_REDIRECT_URI` | `https://.../v1/auth/callback` | — |
| `OIDC_POST_LOGIN_REDIRECT` | путь SPA после входа | `/` |
| `OIDC_DISPLAY_NAME` | имя кнопки входа | `Корпоративный IdP` |
| `OIDC_SCOPES` | scopes | `openid profile email` |
| `OIDC_ALLOWED_ALGORITHMS` | разрешённые alg `id_token` | `RS256` |
| `OIDC_CLOCK_SKEW_SECONDS` | допуск часов | `60` |
| `OIDC_TIMEOUT_MS` | таймаут запросов к IdP | `5000` |
| `OIDC_LOGIN_TTL_SECONDS` | TTL login-транзакции | `600` |
| `OIDC_JIT_PROVISION` | JIT-провижининг | `false` |
| `OIDC_JIT_DEPARTMENT_ID` | подразделение для JIT | — |
| `OIDC_JIT_ROLE` | роль для JIT | `worker` |
| `SIGNATURE_PROVIDER` | `none` / `simple` / `qualified` | `none` |
| `SIGNATURE_SECRET` | секрет HMAC (≥ 32) для `simple` | — |
| `SIGNATURE_KEY_ID` | идентификатор ключа `simple` | `logbook-simple-v1` |
| `SIGNATURE_AUTO_SIGN` | авто-подпись виз/проверок | `true` |
| `SIGNATURE_LEGAL_NOTE` | переопределение оговорки | текст по умолчанию |
| `SIGNATURE_QUALIFIED_ENDPOINT` / `_TOKEN` | сервис КЭП | — |
| `SIGNATURE_QUALIFIED_TIMEOUT_MS` | таймаут КЭП | `5000` |

`.env.example` содержит dev-профиль (dev-вход + `simple` ЭП) и закомментированный
production-профиль OIDC.

### 4.2. Production-гейты (fail-closed)

`loadEnv()`/`parseEnv()` не дают запустить production, если:

- `AUTH_PROVIDER != oidc` (ADR-22 запрещает dev-вход в production);
- `DEV_LOGIN_ENABLED=true`;
- `COOKIE_SECRET` — dev-значение или короче 32 символов;
- `CORS_ORIGIN` — `http://` не на localhost;
- OIDC-профиль неполный, issuer/redirect не https (кроме localhost), JIT без
  подразделения;
- `SIGNATURE_PROVIDER=simple` без `SIGNATURE_SECRET` (≥ 32) или
  `qualified` без endpoint/token.

### 4.3. Пример production

```env
NODE_ENV=production
AUTH_PROVIDER=oidc
DEV_LOGIN_ENABLED=false
COOKIE_SECRET=<56 случайных символов>
CORS_ORIGIN=https://logbook.example.com
OIDC_ISSUER=https://idp.example.com/realms/logbook
OIDC_CLIENT_ID=logbook
OIDC_CLIENT_SECRET=<secret>
OIDC_REDIRECT_URI=https://logbook.example.com/v1/auth/callback
OIDC_ALLOWED_ALGORITHMS=RS256
SIGNATURE_PROVIDER=qualified
SIGNATURE_QUALIFIED_ENDPOINT=https://crypto.example.com/api/sign
SIGNATURE_QUALIFIED_TOKEN=<token>
SIGNATURE_AUTO_SIGN=false
```

`SIGNATURE_AUTO_SIGN=false` для `qualified`: авто-подпись выполняется только для
in-process адаптера (`simple`), чтобы не делать HTTP-вызовы внутри транзакций БД.

---

## 5. Миграция 0007

| Объект | Назначение |
|---|---|
| `user_identities` | связка `(issuer, subject)` → `user_id`, email, last_login |
| `oidc_login_requests` | одноразовые PKCE-транзакции: state_hash, nonce, verifier, redirect, device_id, TTL |
| `devices.install_id/fingerprint/device_key_hash/registered_at/revoked_at` | регистрация устройства и ключ |
| `devices_user_install_uq` | уникальность `(user_id, install_id)` |
| `sessions.device_id` + индекс | привязка сессии к устройству |
| `document_signatures` | подписи: entity, version, content_hash, kind, algorithm, value, key_id, сертификат, signer, status, metadata |
| `signature_kind_enum`, `signature_status_enum`, `signature_entity_type_enum` | типы ЭП |

Миграции применяются существующим мигратором; контрольная сумма SHA-256 защищает
применённые файлы от изменения.

---

## 6. Электронная подпись и OQ-04

**Позиция по OQ-04 не изменилась:** юридическая значимость ЭП не подтверждена.
`simple` — это HMAC-SHA256 сервера (целостность + авторство в рамках Logbook), **не
КЭП/УКЭП**. Поэтому:

- каждый ответ/запись подписи содержит `legal_note` с оговоркой;
- CSV-экспорт содержит строку `# ЭП: ...` и `TODO(OQ-04)`;
- `simple` защищает от подмены в БД, но не даёт юридической силы;
- `qualified` — только адаптер к внешнему сервису КЭП (CMS base64 + сертификат);
  реальная интеграция и проверка УЦ — отдельная задача после OQ-04;
- ротация `SIGNATURE_SECRET`/`SIGNATURE_KEY_ID` делает старые `simple`-подписи
  недействительными (verify вернёт причину) — план ротации ключей не входит в MVP.

Подписывается:

- **виза записи** — канонический хэш `entryVisaContentHash` (schema
  `logbook.entry-visa.v1`: id, version, author, performed_at, work_type, site, permit,
  event_type/data, text, comment, status, verified_at/by). Отзыв визы (`unverify`)
  переводит подпись в `revoked`, изменение записи — в `invalid` при проверке.
- **проверка журнала** — `journal_reviews.content_hash` (id/version записи и HLC),
  подпись идемпотентна для одной проверки.

`POST /v1/signature/{id}/verify` пересчитывает содержимое из БД и проверяет подпись;
для записи дополнительно сверяется `entity_version` (подпись привязана к версии).

---

## 7. Устройства

| Шаг | Поведение |
|---|---|
| Регистрация | `POST /v1/devices {install_id, name?, platform?, app_version?}` → `201 {device, device_key?}` |
| Идемпотентность | повторный вызов с тем же `install_id` возвращает то же устройство; ключ не повторяется |
| Потеря ключа | `rotate_key: true` → новый ключ (старый перестаёт приниматься) |
| Привязка сессии | текущая сессия привязывается к устройству (`sessions.device_id`) |
| Отзыв | `DELETE /v1/devices/{id}` → `status=revoked`, все сессии устройства отозваны, аудит `device.revoke` |
| Синхронизация | push проверяет владельца, `status=active` и `X-Device-Key` (constant-time) |
| Web-клиент | `getInstallId()` (переиспользует legacy `device_id`), ключ хранится в meta `device_key:<id>`, отправляется заголовком |

Администратор может отозвать чужое устройство; supervisor/worker — только своё.
Права на регистрацию — любой аутентифицированный пользователь (устройство всегда
привязано к нему).

---

## 8. Тесты и проверки

| Набор | Что проверяется |
|---|---|
| `apps/api/test/auth-platform.spec.ts` (новый) | env-валидация production/ЭП; PKCE S256 (вектор RFC 7636); подпись/проверка `id_token` (tamper, nonce, aud, exp, alg); регистрация устройств (идемпотентность, ротация ключа, push с/без ключа, отзыв сессии, права); simple-ЭП: авто-подпись визы, `GET /entries/:id`, verify, подмена текста → invalid, unverify → revoked, подпись проверки журнала, запрет чужой подписи |
| `apps/api/test/auth-oidc.spec.ts` (новый) | OIDC end-to-end с подменённым IdP (discovery/token/JWKS): config, отключение dev-login, authorize с PKCE-параметрами и cookie, callback → сессия → `/me`, связка identity, replay `state`, несовпадение cookie, отказ непровиженному пользователю |
| `apps/api/test/db.spec.ts` | миграция 0007, новые таблицы |
| `apps/api/test/api.e2e.spec.ts` | регресс журнального слоя и синхронизации (без изменений контракта) |
| `apps/web/src/sync/engine.test.ts` | регистрация устройства в bootstrap, `device_id`, передача ключа |
| `apps/web/src/screens/LoginScreen.test.tsx` | dev-вход и SSO-режим (кнопка IdP, без формы пароля) |

Команды:

```bash
npm run build:shared
npm run typecheck
npm test
npm run build
```

---

## 9. Ограничения и риски

1. **OQ-02 не закрыт:** конкретный IdP, MFA-политика и redirect URIs не согласованы.
   Код поддерживает стандартный OIDC discovery; MFA обеспечивается IdP, Logbook её не
   дублирует. Для admin MFA обязательна по NFR-SEC-02 — включается политикой IdP.
2. **OQ-04 не закрыт:** `simple` не КЭП; `qualified`-адаптер не проверен на реальном
   сервисе КЭП (контракт описан в отчёте и коде).
3. **JIT выключен по умолчанию** — иначе это была бы самостоятельная регистрация;
   включение требует `OIDC_JIT_DEPARTMENT_ID` и решения заказчика.
4. **Ротация ключей устройств/ЭП** — ручная (re-register / смена секрета); автоматическая
   ротация и несколько активных ключей — вне MVP.
5. **Web-клиент** не показывает подписи и не управляет устройствами в UI (API готов;
   экраны — задачи frontend: S-16/S-14).
6. **IdP timeout/недоступность** — вход невозможен, офлайн-сессия уже выданная
   продолжает работать до истечения (30 дней) — это ожидаемое поведение offline-first.
7. Миграция 0007 аддитивна; откат — вручную (drop tables/columns), как и для остальных
   миграций проекта.

---

## 10. Что дальше

1. Согласовать OQ-02: IdP, MFA для admin, redirect URIs, владелец регистрации клиента.
2. Согласовать OQ-04: гибрид / простая ЭП / КЭП; при КЭП — интеграционный тест
   `qualified`-адаптера с выбранным сервисом.
3. UI: экран устройств (S-16), подпись/проверка подписей в S-14, индикатор «не КЭП» в
   печатных формах.
4. Эксплуатация: секреты в secret-manager, мониторинг `auth_error`, алерты на
   `signature.invalid`, ротация `SIGNATURE_SECRET`.
5. Приёмка на PostgreSQL 15 (миграция 0007 и регистрация устройств) — задача t12.
