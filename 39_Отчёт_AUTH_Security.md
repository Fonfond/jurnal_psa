# Отчёт: AUTH-04/05, rate limit, idle timeout, CSP/HSTS, nginx и SCA

| Параметр | Значение |
|---|---|
| Задача | t22 (REP-04 + REP-07) |
| Статус | Выполнено: rate limit, idle timeout, security headers/CSP/HSTS, исполняемый nginx-конфиг, SCA-обновления + подписанный waiver для dev/build |
| Дата | 27.11.2026 |
| Проверки | `npm run typecheck` — 0; `npm test` — **288** (shared 28 / API 107 / web 153); `npm run build` — ok; `npm audit` — 0 high/critical, 3 moderate (dev/build, waiver) |
| Артефакты | код API, `deploy/nginx/*`, `scripts/security/verify-nginx.ps1`, `docs/security/SCA_WAIVER.md`, 35, RUNBOOK |

---

## 1. Итог

| Находка | Результат |
|---|---|
| REP-04 / AUTH-04: rate limit | ✅ API: фиксированное окно на IP, отдельные лимиты auth/API, `429 E-RATE-01` + `Retry-After` + `X-RateLimit-*`; nginx `limit_req` для auth/API |
| AUTH-04: idle timeout | ✅ `SESSION_IDLE_MINUTES=30` (production ≤ 120): неактивная сессия отзывается (`revoked_at`), следующий запрос — `401` |
| AUTH-05: security headers | ✅ API: `nosniff`, `DENY`, `no-referrer`, `Permissions-Policy`, строгий CSP, `no-store`, COOP/CORP; HSTS только production |
| AUTH-05: CSP/HSTS для SPA | ✅ nginx: CSP `deploy/nginx/spa-csp.conf`, HSTS `max-age=31536000; includeSubDomains`, заголовки во всех location |
| REP-04: исполняемый nginx | ✅ `deploy/nginx/nginx.conf` + 2 snippet; `nginx -t` на nginx 1.28.0 — **successful** (`scripts/security/verify-nginx.ps1`) |
| REP-07: SCA | ✅ zod 3→4.6.7 (high), react-router 6→7.18.7 (moderate), vitest 3→5.1.2 (critical), vite-plugin-pwa 2→1.1 (moderate); осталось 3 moderate dev/build — подписанный waiver |
| Production fail-closed / dev-login | ✅ сохранено: production требует OIDC, `DATABASE_URL`, собственные секреты, TLS, rate limit, idle ≤120, HSTS ≥1 день; dev-вход запрещён (тесты) |
| Тесты | ✅ `security.spec.ts` (7 тестов: headers, HSTS unit, auth/API rate limit, fixed window, idle reject/keep) + env-gate тесты; полный прогон 288 |

---

## 2. Rate limit (AUTH-04)

Реализация — `apps/api/src/common/rate-limit.ts`, подключается в `configure-app.ts`
до маршрутов, после `requestContext` (чтобы `request_id` попадал в 429).

- Fixed-window на ключ `IP:auth|api`; `auth` — `/v1/auth/dev-login|authorize|callback`,
  остальные `/v1/*` — общий лимит; `/v1/health` исключён; `OPTIONS` не лимитируется.
- Ответ при превышении: `429`, `Retry-After`, `X-RateLimit-Limit/Remaining/Reset`,
  тело `{ "error": { "code": "E-RATE-01", "message": "...", "request_id": "..." } }`.
- Настройки: `RATE_LIMIT_ENABLED` (по умолчанию true), `RATE_LIMIT_WINDOW_SECONDS=60`,
  `RATE_LIMIT_MAX=300`, `AUTH_RATE_LIMIT_WINDOW_SECONDS=900`, `AUTH_RATE_LIMIT_MAX=20`.
- Очистка просроченных bucket'ов при росте Map; лимитер **per-process** — при
  горизонтальном масштабировании обязателен edge-лимит nginx (`limit_req`) или
  общий store; это зафиксировано в коде и 35 §7.2.

Тесты: 3-й логин при `AUTH_RATE_LIMIT_MAX=2` → 429 + Retry-After; 4-й `GET /me`
при `RATE_LIMIT_MAX=3` → 429; unit-проверка окна (blocked → reset → allowed).

## 3. Idle timeout (AUTH-04)

`apps/api/src/auth/auth.service.ts`: в `resolveSession` выбран `last_seen_at`;
если простой больше `SESSION_IDLE_MINUTES`, сессия атомарно отзывается
(`update sessions set revoked_at = now()`) и запрос получает `401`. Активный запрос
обновляет `last_seen_at` (как и раньше). `SESSION_TTL_DAYS` остаётся абсолютным
сроком (30 дней) — idle timeout его не продлевает.

Тесты: сессия с `last_seen_at = now() - 31 min` → `401`, `revoked_at` заполнен;
`-5 min` → `200`. Production-гейт: `SESSION_IDLE_MINUTES > 120` отклоняется.

## 4. Security headers и CSP/HSTS (AUTH-05)

`apps/api/src/common/security-headers.ts` (на всех ответах API):

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), usb=()
Content-Security-Policy: default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-site
X-Permitted-Cross-Domain-Policies: none
Cache-Control: no-store
Strict-Transport-Security: max-age=31536000; includeSubDomains   (только production)
```

SPA-заголовки задаёт nginx: `deploy/nginx/security-headers.conf` (HSTS + базовые)
и `deploy/nginx/spa-csp.conf` (`default-src 'self'; script-src 'self';
style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self' blob:;
object-src 'none'; base-uri 'self'; frame-ancestors 'none'`). `'unsafe-inline'`
в `style-src` нужен из-за inline-style React; скрипты — только self.

CORS расширен под реальные заголовки клиента: `X-Device-Key`, `X-App-Version`,
`Idempotency-Key`; ответы экспонируют `X-RateLimit-*`, `Retry-After`.

## 5. Исполняемый nginx-конфиг

Файлы:

| Файл | Содержимое |
|---|---|
| `deploy/nginx/nginx.conf` | два origin (app/admin), TLS 1.2/1.3, `http2 on`, `limit_req`/`limit_conn`, upstream loopback, no-store для SW/index, immutable `/assets`, SPA fallback, `server_tokens off` |
| `deploy/nginx/security-headers.conf` | HSTS, nosniff, DENY, Referrer-Policy, Permissions-Policy, COOP/CORP |
| `deploy/nginx/spa-csp.conf` | CSP для SPA |
| `scripts/security/verify-nginx.ps1` | скачивает nginx 1.28.0 для Windows, подставляет пути/сертификат, запускает `nginx -t` |

Фактический вывод проверки:

```
nginx version: nginx/1.28.0
nginx: the configuration file C:/jurnal/.data/nginx/verify/conf/nginx.conf syntax is ok
nginx: configuration file ... test is successful
NGINX CONFIG OK
```

Production-пути в конфиге — `/etc/nginx/certs/logbook.crt|key` и `/var/www/logbook`;
скрипт проверки заменяет их на временные, не меняя production-файл.

## 6. SCA (REP-07)

До обновлений: **10** уязвимостей — 2 critical (`vitest`/`tinypool`), 1 high (`zod`),
7 moderate (`react-router*`, `vite-plugin-pwa`/`workbox-build`/`glob`/`minimatch`,
`@vitest/mocker`). После:

| Пакет | Было | Стало | Устранено |
|---|---|---|---|
| `zod` | 3.25.76 | 4.6.7 | high (memory exhaustion) |
| `react-router-dom` | 6.30.x | 7.18.7 | moderate (open redirect / SSR hydration) |
| `vitest` | 3.2.7 | 5.1.2 | critical (tinypool RCE, mocker file read) |
| `vite-plugin-pwa` | 2.0.0 | 1.1.0 | moderate (Workbox advisory range) |
| `@vitest/mocker`, `tinypool` | — | транзитивно обновлены | critical/moderate |

`npm audit` после: `{moderate: 3, high: 0, critical: 0}` — только dev/build-цепочка
Workbox (`workbox-build >=7.4.0`, `glob 11.1.0`, `minimatch 10.2.6`). Они не входят
в production-артефакт (`npm ci --omit=dev`), работают с шаблонами репозитория и не
исполняются в браузере/API. Waiver с компенсациями и подписью владельца ИБ —
`docs/security/SCA_WAIVER.md` (SCA-WAIVER-2026-11-27).

Совместимость zod 4: исправлены `z.record` (2 аргумента) и `issue.path`
(`PropertyKey[]`); тесты API (106) и shared (28) проходят. React Router 7:
маршрутизация/тесты web (153) проходят; vitest 5: включён `include src/**` для
shared (иначе dist-тесты), поднят `testTimeout` web до 20 с.

## 7. Production fail-closed и dev-login

Сохранены и расширены гейты `env.ts`:

- production: `AUTH_PROVIDER=oidc`, `DEV_LOGIN_ENABLED=false`, `DATABASE_URL`,
  TLS к БД, собственные секреты, https origins, ЭП-конфигурация;
- новое (AUTH-04/05): `RATE_LIMIT_ENABLED=true`, `AUTH_RATE_LIMIT_MAX ≤ 100`,
  `SESSION_IDLE_MINUTES ≤ 120`, `HSTS_MAX_AGE_SECONDS ≥ 86400`.
- dev-login запрещён и по провайдеру, и в production (`E-AUTH-02`); тест
  `auth-platform.spec` подтверждает отказ.

## 8. Тесты и проверки

| Команда | Результат |
|---|---|
| `npm run typecheck` | 0 (shared + API + web + SW) |
| `npm test` | 288 passed: shared 28, API 107 (17 suites), web 153 |
| `node .../jest test/security.spec.ts` | 7/7 (headers, HSTS unit, auth/API rate limit, fixed window, idle) |
| `scripts/security/verify-nginx.ps1` | `nginx -t` successful (nginx 1.28.0) |
| `npm audit` | 0 high/critical; 3 moderate dev/build (waiver) |
| `npm run build` | shared + API + web ок; PWA precache 11 / 606,75 КиБ; JS 592,21 КБ (gzip 174,01 КБ) |

## 9. Остаточные риски

1. API rate limiter — **per-instance**; без nginx/общего store лимит умножается на
   число реплик. Edge-лимит в `deploy/nginx/nginx.conf` обязателен.
2. CSP SPA содержит `style-src 'unsafe-inline'` (inline-style React); переход на
   nonce/hash — отдельная задача при отказе от inline-стилей.
3. HSTS включается только в production и зависит от TLS-терминации nginx; при
   прямом HTTP-доступе к API HSTS не защищает (порт должен быть закрыт).
4. Idle timeout проверяется сервером; SPA узнаёт о завершении по `401` (UX-подсказка
   не добавлялась).
5. 3 moderate npm audit в dev/build Workbox — приняты waiver'ом; пересмотр при
   обновлении Workbox (не позднее 27.05.2027).
6. Rate limit не заменяет WAF/защиту от распределённых атак; L3/L7-защита — зона
   инфраструктуры заказчика.

## 10. Изменённые файлы

- `apps/api/src/common/security-headers.ts`, `rate-limit.ts`, `configure-app.ts`;
- `apps/api/src/auth/auth.service.ts` (idle timeout), `apps/api/src/config/env.ts`;
- `apps/api/src/common/zod-validation.pipe.ts`, `shifts/shifts.service.ts`,
  `sync/sync.service.ts`, контроллеры `audit/dictionaries/journal/permits`
  (zod 4 `z.record`/`PropertyKey[]`);
- `packages/shared/src/schemas.ts`, `packages/shared/vitest.config.ts`;
- `deploy/nginx/{nginx.conf,security-headers.conf,spa-csp.conf}`,
  `scripts/security/verify-nginx.ps1`;
- `docs/security/SCA_WAIVER.md`;
- `package.json`/lock (zod 4, react-router 7, vitest 5, vite-plugin-pwa 1.1),
  `apps/web/vitest.config.ts`;
- `35_Руководство_по_установке.md`, `RUNBOOK.md`, `.env.example`.

Связанные: ADR-06 (cookie-сессии), ADR-14 (admin origin), ADR-22/23 (auth),
AUTH-04/AUTH-05, REP-04/REP-07, OQ-02/OQ-04 (внешние условия не меняются).
