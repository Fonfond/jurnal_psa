# Logbook — запуск и разработка

| Параметр | Значение |
|---|---|
| Статус | Функциональный слой t1–t20 + ремонт t21–t26 в рабочем дереве; **release t15 — FAIL / не принят** (`38_Релизный_отчёт.md`), production readiness не заявляется. Остаток/гейты — `24_Остаток_разработки.md` v3.0, матрица FR — `07_Матрица_трассируемости.md` v3.0 |
| Версия | 0.9.3 |
| Node | ≥ 22 (проверено на 26.13.1) |
| Пакетный менеджер | npm 11 (workspaces) |
| БД | PGlite локально, PostgreSQL 15 в production (TLS 1.2+, WAL-архив) |
| Документация | `35_Руководство_по_установке.md`, `36_Руководство_пользователя_и_администратора.md`, `24_Остаток_разработки.md` (v3.0), `07_Матрица_трассируемости.md` (v3.0), `38_Релизный_отчёт.md`, `18_Технический_бриф_и_план_реализации.md`, `26_Отчёт_Auth_Platform.md`, `29_Отчёт_PostgreSQL_Production.md` |

---

## 1. Быстрый старт

```bash
npm install
npm run build:shared
cp .env.example .env      # Windows: copy .env.example .env
npm run db:migrate
npm run db:seed
npm run dev:api           # http://localhost:3001/v1
npm run dev:web           # http://localhost:5173
```

Production-сборка и запуск API:

```bash
npm run build             # shared + api + web
npm run start:prod --workspace @logbook/api
```

Проверка API:

```bash
curl http://localhost:3001/v1/health
# {"status":"ok","db":"ok","latency_ms":1,"server_time":"...","version":"0.1.0"}
```

> Production-контур (PostgreSQL 15, TLS, OIDC, systemd/nginx, Docker, backup/restore, обновление и удаление) — [35_Руководство_по_установке.md](35_Руководство_по_установке.md). Этот RUNBOOK описывает локальный/dev-контур; seed ниже — только для него.

> Инструкции для пользователей и администратора (экраны, шаги, скриншоты) — [36_Руководство_пользователя_и_администратора.md](36_Руководство_пользователя_и_администратора.md).

Dev-пользователи (пароль из `DEV_SEED_PASSWORD`, по умолчанию `Logbook!2026`):

| Email | Роль |
|---|---|
| `worker@logbook.local` | worker |
| `supervisor@logbook.local` | supervisor |
| `admin@logbook.local` | admin |

---

## 2. База данных

### 2.1. Локально (PGlite)

По умолчанию используется PGlite — PostgreSQL, скомпилированный в WASM (ADR-21). Данные лежат в `.data/pglite`.

```bash
npm run db:migrate   # применить все миграции (0001…0016)
npm run db:seed      # миграции + детерминированный seed
```

Сброс локальной базы:

```bash
rm -rf .data/pglite   # Windows: rmdir /s /q .data\pglite
npm run db:seed
```

### 2.2. Production (PostgreSQL)

Задайте `DATABASE_URL` в `.env` — клиент автоматически переключится на `pg`:

```env
DATABASE_URL=postgres://logbook:logbook@localhost:5432/logbook
```

SQL-миграции и seed общие; `docker-compose.yml` — для сред, где есть Docker.

### 2.3. Миграции

| Файл | Содержание |
|---|---|
| `0001_init.sql` | enums, departments, users, sessions, devices, dictionary_versions, user_credentials |
| `0002_dictionaries.sql` | sites, work_types, templates, correction_reasons, permits, participants |
| `0003_journal.sql` | journal_entries, revisions, workers, attachments, conflicts |
| `0004_sync_audit.sql` | change_log, idempotency, audit_events, export_jobs |
| `0005_field_clocks.sql` | `journal_entries.field_clocks` для полевого merge |
| `0006_operational_journal.sql` | event_type/event_data, journal_seq, late_entry, journal_reviews |
| `0007_auth_platform.sql` | user_identities, oidc_login_requests, install_id/device_key, sessions.device_id, document_signatures |
| `0008_multi_journal.sql` | журналы, доступы и `journal_id` (мультижурнальность, задача t3) |
| `0009_shifts.sql` | `shifts`, сдача-приёмка смены и `entity_type='shift'` для подписей (задача t4) |
| `0010_groundings.sql` | реестр заземлений `groundings`, состояния и активная установка (задача t5) |
| `0011_permit_pdf.sql` | PDF-метаданные наряда (`pdf_generated_at`, `pdf_source`) для signed URL (t6) |
| `0012_retention_export.sql` | WORM-экспорт (`export_jobs`: файлы/hash/manifest/подпись), `retention_runs`, `archive_manifests`, `backup_checkpoints`, guard удаления (t7) |
| `0017_retention_scheduler.sql` | `retention_runs.trigger/status/run_date`, `retention_alerts`, TTL-разрешение не-WORM `export_jobs` (t24) |
| `0013_batch_journal_seq.sql` | Батчевый push: trigger не трогает `journal_counters` для явного `journal_seq`, индекс (t17) |
| `0014_journal_sequences.sql` | Per-journal sequence `journal_seq_<uuid>` для блочной выдачи номеров; trigger через sequence (t17) |
| `0015_audit_outbox_gapless_seq.sql` | Durable `audit_outbox` (REP-06), backfill `journal_counters` из `max(journal_seq)`, temp sequence и gapless allocator (исторический t23) |
| `0016_journal_seq_gaps_policy.sql` | Sequence-блоки `journal_seq` для push, синхронизация sequence с max, политика допустимых разрывов при откате/аварии (t29) |
| `0015_audit_outbox_gapless_seq.sql` | `audit_outbox` (доставка аудита в той же транзакции), транзакционный `journal_seq` без разрывов при откате (t23/REP-06) |

Защита: `schema_migrations` хранит SHA-256; изменение применённого файла вызовет ошибку.

**Production-установка, TLS, systemd/nginx, обновление, backup/restore, диагностика и удаление** — [35_Руководство_по_установке.md](35_Руководство_по_установке.md). Ниже — локальный/dev-контур; seed в production не применяется (только bootstrap-администратор и справочники, §6.6 руководства).

### 2.4. Seed

Детерминированные ID (UUID v7) и HLC (13:5:8) находятся в `packages/shared/src/seed-data.ts`:

- 3 пользователя, 3 устройства;
- 3 типа работ, 2 объекта, 2 шаблона, 3 причины;
- 2 журнала: `main` и `substation` (независимая нумерация; доступ к `substation` выдаётся администратором);
- 3 наряда: active / closed / annulled;
- 5 записей: manual, voice (`on_device`), удалённая, с флагом риска; все — в журнале `main`.

Повторный запуск seed не создаёт дублей.

---

## 3. API

Все маршруты под `/v1`, кроме `/auth/config`, `/auth/authorize`, `/auth/callback`, `/auth/dev-login` и health, требуют cookie-сессию. Мутации требуют `X-CSRF-Token`, равный cookie `lb_csrf`.

```bash
# вход
curl -c cookies.txt -X POST http://localhost:3001/v1/auth/dev-login \
  -H 'Content-Type: application/json' \
  -d '{"email":"worker@logbook.local","password":"Logbook!2026"}'

# профиль
curl -b cookies.txt http://localhost:3001/v1/me

# лента
curl -b cookies.txt 'http://localhost:3001/v1/entries?limit=10'
```

Основные группы: `auth`, `me`, `devices`, `journals` (+ admin CRUD/members), `shifts` (+ accept/reject), `groundings`, `entries` (+ verify/unverify/restore/sign), `conflicts`, `sync/push|changes`, `permits` (PDF/import), `dictionaries/snapshot`, `audit`, `exports` (+ signed URL/download), `journal/exports` (WORM PDF/CSV), `admin/exports`, `admin/retention|audit/verify|backup`, `admin/users`, `journal/reviews` (+ sign/signatures), `signature` (+ info/verify), `journal/export`.

### 3.1. Аутентификация

Два провайдера (ADR-22/ADR-23), переключаются `AUTH_PROVIDER`:

| Режим | Вход | Когда |
|---|---|---|
| `dev` | `POST /v1/auth/dev-login` (email + пароль из seed) | локальный запуск, тесты |
| `oidc` | `GET /v1/auth/authorize` → IdP → `GET /v1/auth/callback` | production |

```bash
# публичная конфигурация для SPA (без секретов)
curl http://localhost:3001/v1/auth/config

# OIDC: редирект на IdP (Authorization Code + PKCE)
curl -i 'http://localhost:3001/v1/auth/authorize?redirect_after=%2F'
```

OIDC: `state`/`nonce`/PKCE S256, проверка `id_token` по JWKS, login-транзакции
одноразовые и живут 10 минут. Самостоятельной регистрации нет: пользователь должен быть
создан администратором (поиск по подтверждённому email) либо включён JIT
(`OIDC_JIT_PROVISION=true` + `OIDC_JIT_DEPARTMENT_ID`). Ошибка входа возвращает
`302 /login?auth_error=...`.

`POST /v1/auth/dev-login` возвращает `auth_provider`, профиль, cookie сессии и CSRF;
`GET /v1/me` дополнительно отдаёт `auth.provider` и режим ЭП (`signature`).

### 3.2. Устройства

```bash
# регистрация (идемпотентно по install_id); device_key возвращается один раз
curl -b cookies.txt -X POST http://localhost:3001/v1/devices \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"install_id":"install-abc-0001","name":"Android D1","platform":"Android 14","app_version":"0.2.0"}'

# синхронизация с ключом устройства
curl -b cookies.txt -X POST http://localhost:3001/v1/sync/push \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -H 'X-Device-Key: <device_key>' -d @push.json

# отзыв: устройство + все его сессии
curl -b cookies.txt -X DELETE http://localhost:3001/v1/devices/<id> \
  -H "X-CSRF-Token: $CSRF"
```

Последствия: отозванное устройство не может синхронизироваться; сессия, привязанная к
устройству при регистрации, инвалидируется. Устройства без `device_key_hash` (seed,
старый клиент) работают без заголовка — обратная совместимость.

### 3.3. Электронная подпись (OQ-04)

| `SIGNATURE_PROVIDER` | Поведение | Юридический статус |
|---|---|---|
| `none` | без подписи | как в MVP |
| `simple` | HMAC-SHA256 сервера, авто-подпись виз и проверок | **не КЭП**, оговорка в каждом ответе |
| `qualified` | HTTP-адаптер к сервису КЭП (CMS + сертификат) | требует OQ-04 и интеграции УЦ |

```bash
curl -b cookies.txt http://localhost:3001/v1/signature/info

# подписать проверку журнала / визу записи
curl -b cookies.txt -X POST http://localhost:3001/v1/journal/reviews/<id>/sign \
  -H "X-CSRF-Token: $CSRF" -d '{}'
curl -b cookies.txt -X POST http://localhost:3001/v1/entries/<id>/sign \
  -H "X-CSRF-Token: $CSRF" -d '{}'

# проверить подпись по актуальному содержимому
curl -b cookies.txt -X POST http://localhost:3001/v1/signature/<signature_id>/verify \
  -H "X-CSRF-Token: $CSRF"
```

Авто-подпись выполняется только для `simple` (`SIGNATURE_AUTO_SIGN=true`); для
`qualified` используйте ручные endpoint'ы. `unverify` переводит подпись визы в
`revoked`, изменение записи делает её `invalid` при проверке. CSV-экспорт содержит
строку `# ЭП: ...` и `TODO(OQ-04)`.

### 3.4. Мультижурнальность

Журнал `main` доступен всем; остальные журналы требуют гранта (`read`/`write`/`manage`).
`admin` управляет всеми журналами, `auditor` читает активные.

```bash
# доступные журналы (в ответе access_level)
curl -b cookies.txt http://localhost:3001/v1/journals

# записи выбранного журнала
curl -b cookies.txt 'http://localhost:3001/v1/entries?journal_id=<uuid>'

# создание журнала и грант пользователю (admin)
curl -b cookies.txt -X POST http://localhost:3001/v1/admin/journals \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"journal_key":"workshop","name":"Ремонтный журнал","sort_order":30}'
curl -b cookies.txt -X PUT http://localhost:3001/v1/admin/journals/<id>/members/<user_id> \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"access_level":"write"}'

# виза и экспорт по журналу
curl -b cookies.txt -X POST http://localhost:3001/v1/journal/reviews \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"journal_id":"<uuid>","period_start":"2026-11-01","period_end":"2026-11-30"}'
curl -b cookies.txt 'http://localhost:3001/v1/journal/export?journal_id=<uuid>'
```

`journal_seq` выделяется отдельно в каждом журнале (счётчик `journal_counters`), поэтому
номера в разных журналах не связаны. `journal_id` записи неизменяем; в старых клиентах
без поля запись создаётся в `main`.

### 3.5. Сдача-приёмка смены

```bash
# сдать смену (supervisor/admin): окно и комментарий
curl -b cookies.txt -X POST http://localhost:3001/v1/shifts \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"journal_id":"<uuid>","shift_date":"2026-11-24",
       "period_start":"2026-11-24T05:00:00.000Z","period_end":"2026-11-24T17:00:00.000Z",
       "handover_comment":"Смена сдана, журнал проверен"}'

# принять/отклонить (другой supervisor/admin)
curl -b cookies.txt -X POST http://localhost:3001/v1/shifts/<id>/accept \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"action":"accept","comment":"Принято, замечаний нет"}'
curl -b cookies.txt -X POST http://localhost:3001/v1/shifts/<id>/reject \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"action":"reject","rejection_reason":"Не приложены ведомости"}'

# список и карточка с подписями
curl -b cookies.txt 'http://localhost:3001/v1/shifts?status=handed_over'
curl -b cookies.txt http://localhost:3001/v1/shifts/<id>
```

Смену принимает другой пользователь (свою принять нельзя); активная смена одна на окно
журнала, после отклонения можно сдать заново. Сдача и приёмка подписываются настроенным
ЭП-адаптером (`SIGNATURE_PROVIDER=simple|qualified`), иначе сохраняются без подписи с
оговоркой; обе стороны работают офлайн через `sync/push` (`entity_type='shift'`).

### 3.6. Реестр заземлений

```bash
# реестр: активные установки выбранного журнала
curl -b cookies.txt 'http://localhost:3001/v1/groundings?journal_id=<uuid>&state=applied'

# установка/снятие — обычной записью журнала через sync/push
curl -b cookies.txt -X POST http://localhost:3001/v1/sync/push \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"device_id":"<device>","app_version":"0.2.0","ops":[{"op_id":"<uuid>",
       "entity_type":"entry","entity_id":"<uuid>","op_type":"create",
       "base_version":null,"hlc":"1795000000400:00001:sw000001",
       "client_time":"2026-11-25T08:00:00.000Z","payload":{"performed_at":"2026-11-25T07:55:00.000Z",
       "performed_tz_offset_min":180,"work_type_id":"<uuid>","site_id":"<uuid>",
       "text":"Установлено переносное заземление","input_method":"manual",
       "event_type":"grounding","event_data":{"action":"applied","grounding_type":"portable",
       "point":"КЛ-10 кВ, яч. 5","tool_number":"T-1","count":1}}}]}'
```

Строка реестра создаётся сервером из события: `applied` открывает активную, `removed`
закрывает. Повторная установка/снятие не блокирует запись, но возвращает
`status=conflict` (`grounding_state`) и создаёт конфликт для разбора. Событие
заземления неизменяемо — для нового состояния нужна новая запись. Переключения
(`event_type='switching'`) принимают структурированные `operations`/`checks` по бланку 757
(см. `06_Контракт_API.md` §3.10); старый `sequence` тоже принимается.

### 3.7. PDF наряда и импорт источника

```bash
# signed URL (TTL ≤ 900 с); источник PDF — сервер или внешняя система
curl -b cookies.txt -X POST http://localhost:3001/v1/permits/<id>/pdf-url \
  -H "X-CSRF-Token: $CSRF"
# → {"url":"/v1/permits/pdf/<id>?token=...","expires_at":"...","source":"generated",
#    "hash":"…","size_bytes":223553,"deep_link":"https://…","pdf_url":null}

# скачивание (сессия обязательна; проверяются подпись, срок и версия наряда)
curl -b cookies.txt -o permit.pdf 'http://localhost:3001/v1/permits/pdf/<id>?token=<token>'

# импорт JSON-фида источника (адаптер) — идемпотентно по source_id/external_id
curl -b cookies.txt -X POST http://localhost:3001/v1/admin/permits/import \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"source_id":"external-json","records":[{"external_id":"EXT-1","number":"НД-1/2026",
       "year":2026,"type":"permit_to_work","status":"active",
       "valid_from":"2026-12-01","valid_to":"2026-12-31","site_code":"SITE-01",
       "description":"Работы по внешнему наряду","responsible_login":"supervisor@logbook.local",
       "external_url":"https://permits.example.local/1",
       "pdf_url":"https://permits.example.local/files/1.pdf"}]}'
```

Параметры: `PERMIT_PDF_SECRET` (fallback `COOKIE_SECRET`), `PERMIT_PDF_TTL_SECONDS`
(60–900), `PERMIT_PDF_PUBLIC_BASE_URL` для абсолютных ссылок. PDF наряда
формируется встроенным UTF-8 шрифтом; при наличии `pdf_url` источника signed URL
перенаправляет на внешний deep link (302). Скачивание/выдача ссылки аудируются
(`permit.pdf_download`, `permit.pdf_url`); после изменения наряда ссылка устаревает.
Файл шрифта `apps/api/assets/OpenSans-Regular.ttf` должен копироваться при упаковке
API рядом с `dist`.

### 3.8. Retention, WORM-экспорт и backup

```bash
# политика 3 года, счётчики, последние проверки и checkpoints
curl -b cookies.txt http://localhost:3001/v1/admin/retention
curl -b cookies.txt http://localhost:3001/v1/admin/audit/verify

# отчёт + проверка hash-цепочки аудита (now — для ускоренного теста)
curl -b cookies.txt -X POST http://localhost:3001/v1/admin/retention/run \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"now":"2029-11-25T00:00:00.000Z"}'

# ежедневный scheduler вручную (идемпотентен в пределах UTC-дня)
curl -b cookies.txt -X POST http://localhost:3001/v1/admin/retention/scheduler/run \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{}'

# алерты (run_failed/audit_broken/run_overdue)
curl -b cookies.txt 'http://localhost:3001/v1/admin/retention/alerts?limit=50'

# WORM PDF 3-графной формы + CSV (supervisor/admin/auditor)
curl -b cookies.txt -X POST http://localhost:3001/v1/journal/exports \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"journal_id":"<uuid>","from":"2026-11-01","to":"2026-11-30"}'

# signed URL и скачивание
curl -b cookies.txt -X POST http://localhost:3001/v1/exports/<id>/url \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{"format":"pdf"}'
curl -b cookies.txt -o journal.pdf 'http://localhost:3001/v1/exports/<id>/download?format=pdf&token=<token>'

# архив записей старше cutoff (только admin; to ≤ cutoff)
curl -b cookies.txt -X POST http://localhost:3001/v1/admin/retention/archive \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"journal_id":"<uuid>","from":"2019-01-01","to":"2022-12-31"}'
```

Политика — `RETENTION_YEARS` (по умолчанию 3; OQ-05/OQ-18 не утверждены), физическое удаление записей моложе срока блокирует триггер БД. Ежедневный scheduler (`RETENTION_SCHEDULER_ENABLED=true`, `RETENTION_SCHEDULE_UTC=02:00`) идемпотентен в пределах UTC-дня, чистит `change_log` (90 дней) и просроченные не-WORM `export_jobs`, пишет `retention_alerts` (+ optional webhook); для нескольких реплик используйте внешний cron/timer с `RETENTION_SCHEDULER_ENABLED=false`. Завершённый экспорт и `archive_manifests` неизменяемы/неудаляемы (WORM). Signed URL экспорта живёт ≤ 900 с (`EXPORT_URL_TTL_SECONDS`, секрет `EXPORT_SIGNING_SECRET`/`COOKIE_SECRET`). Перед backup:

```powershell
# зафиксировать checkpoint (manifest: таблицы, головы аудита, хэши экспортов)
curl -b cookies.txt -X POST http://localhost:3001/v1/admin/backup/checkpoint `
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{"label":"pre-backup"}'
scripts/pg/backup.ps1
```

`GET /v1/admin/backup/manifest` отдаёт manifest (счётчики таблиц, головы аудита, хэши экспортов) для сверки после восстановления; `POST /v1/admin/backup/checkpoint` пишет `backup.checkpoint` в аудит. WORM-экспорты входят в backup (bytea в `export_jobs`).

### 3.9. Web-клиент

```bash
npm run dev:web     # http://localhost:5173
```

Vite проксирует `/v1` на `http://localhost:3001`, поэтому cookie-сессия и CSRF работают same-origin.

Экран входа запрашивает `/v1/auth/config`: при `auth_provider=oidc` показывается кнопка
«Войти через IdP» (без формы пароля), при `dev` — быстрый dev-вход. Синхронизация при
старте регистрирует устройство по `install_id`, сохраняет `device_key` и отправляет его
в заголовке `X-Device-Key`.

| Маршрут | Экран |
|---|---|
| `/login` | S-01, dev-вход или OIDC |
| `/` | S-02, лента и поиск |
| `/entries/new` | S-03, создание |
| `/entries/:id` | S-05, карточка и ревизии |
| `/entries/:id/edit` | S-03, правка |
| `/permits` | S-07, наряды |
| `/shifts` | S-15, сдача-приёмка смены |
| `/groundings` | S-16, реестр заземлений |
| `/sync` | S-10, очередь и повторы |
| `/conflicts` | S-13, разбор |
| `/journal/reviews` | S-14, визы/проверки журнала |
| `/journal/print` | печатная 3-графная форма |

Флаги web (`.env`):

```env
VITE_API_URL=/v1
VITE_APP_VERSION=0.2.0
VITE_ENABLE_DEV_LOGIN=true
VITE_DEV_PASSWORD=Logbook!2026
VITE_ENABLE_ON_DEVICE_ASR=false
VITE_ENABLE_WEB_SPEECH=false
```

Особенности: данные пишутся в Dexie, отправка — через outbox ≤ 50 операций и ≤ 3 сущностей параллельно, Web Locks, backoff 2–15 минут, 10 попыток → `dead`.

PWA: manifest, standalone, precache, `/v1` — NetworkOnly, offline-оболочка.

#### 3.6.1. Локальные данные, блокировка и фоновая синхронизация (t10)

Хранилище разделено по владельцу (подробно — `27_Отчёт_Offline_Platform.md`):

| База | Что хранит | Когда удаляется |
|---|---|---|
| `logbook:device` | `device_id`, `install_id`, `device_key`, HLC-узел, CSRF для SW, активный пользователь, статус Background Sync, `offline_session:<user_id>` (PBKDF2-verifier PIN, снимок пользователя/сессии, попытки) | только при явной отвязке устройства (DevTools → Application → IndexedDB) |
| `logbook:user:<user_id>` | записи, визы, смены, очередь, черновики, справочники, кэш руководителя | при «Выйти» (logout с очисткой) |
| `logbook` (legacy) | старая общая база до первого входа | автоматически после переноса строк пользователя (снимок сохраняется) |

Проверить в браузере: DevTools → Application → IndexedDB. После входа должен появиться `logbook:user:<uuid>`; после смены пользователя — второй такой же. Ключи из `logbook:device` должны сохраняться между входами.

* **Заблокировать** (в шапке) — закрывает доступ и соединение с БД, данные остаются. Разблокировка: PIN-код, если он задан (работает офлайн), иначе повторный вход по паролю/IdP (нужна сеть). Блокировка сохраняется и после перезагрузки страницы.
* **Выйти** — удаляет базу этого пользователя целиком вместе с локальным PIN/офлайн-сессией. Если очередь не отправлена, при следующем входе её уже не будет: предупредите пользователя.
* **Кэш руководителя** (S-10 «Синхронизация»): для `supervisor`/`admin` — последние 7 дней каждого журнала и визы, бюджет 15 МиБ. Обновляется при синхронизации не чаще раза в 6 часов, кнопка «Обновить кэш» — принудительно. Объём и число записей видны на карточке.
* **Background Sync**: после закрытия вкладки очередь отправляет service worker (`/service-worker.js`, тег `logbook-sync`). В Chrome/Edge событие ставится в очередь браузером; в Safari/iOS фоновой отправки нет — S-10 показывает честное сообщение, очередь уйдёт при следующем открытии приложения.
* **Диагностика**: `logbook:device` → `background_sync_status`, `sw_last_flush`; в пользовательской базе `meta` → `sync_last_at`, `sync_error`, `migration_report`, `supervisor_cache_status`.
* **Сбой миграции IDB**: приложение покажет ошибку и не откроет повреждённый кэш; снимок остаётся в `logbook:...#snapshot:<ts>` — можно восстановить вручную через DevTools или удалить пользовательскую базу (данные перезагрузятся с сервера).

Ограничения: IndexedDB не шифруется (ADR-20, SYN-03); кэш руководителя требует письменного согласования OQ-21; квоты/вытеснение — SYN-01.

#### 3.6.2. PIN и офлайн-восстановление сессии (AUTH-03)

PIN — локальная разблокировка после «Заблокировать» и после перезагрузки страницы без сети. Он не заменяет пароль/IdP и не шифрует IndexedDB: это защита от доступа к уже открытому на устройстве журналу (ADR-20/SYN-03).

**Задать PIN.** Войдите → «Синхронизация» → «Безопасность» → введите 4–8 цифр → «Задать PIN». Там же «Сменить PIN»/«Удалить PIN». Слабые PIN (`1234`, `0000` и т.п.) и нецифровые значения отклоняются.

**Как хранится.** В `logbook:device` → `meta` → `offline_session:<user_id>` лежит JSON: снимок пользователя и сессии, флаг `locked`, счётчик неудачных попыток и verifier PIN — PBKDF2-SHA256, случайная соль 16 байт, 150 000 итераций. Сам PIN в открытом виде **не хранится**. Проверить: DevTools → Application → IndexedDB → `logbook:device` → `meta` — в значении должны быть `salt`/`hash`/`iterations`, но не цифры PIN.

**Разблокировка и попытки.**
* Введите PIN на экране «Сессия заблокирована». 5 неверных попыток блокируют разблокировку на 5 минут; счётчик и блокировка сохраняются при перезагрузке.
* Успешная разблокировка открывает пользовательскую базу (`logbook:user:<id>`) и продолжает работу; локальные данные, очередь и черновики сохраняются.
* Если PIN забыт: войдите онлайн по паролю/IdP (это сбрасывает попытки и открывает журнал), затем задайте новый PIN в «Безопасность». Офлайн при забытом PIN разблокировка невозможна.

**Восстановление после перезагрузки без сети.**
* Если сессия не была заблокирована и срок офлайн-сессии (`SESSION_TTL_DAYS`, по умолчанию 30 дней) не истёк, приложение автоматически открывает последний аккаунт с устройства по снимку в `offline_session` и работает из IndexedDB; при подключении синхронизация продолжится.
* Если сессия была заблокирована — после перезагрузки показывается PIN-экран (даже при наличии сети).
* Восстанавливается только последний пользователь устройства (`last_user_id`), и только если его база `logbook:user:<id>` существует. Истёкшая или отсутствующая сессия не восстанавливается — экран входа сообщит «Офлайн-сессия не найдена или истекла».
* Смена пользователя: у каждого аккаунта свой `offline_session`; «Выйти» удаляет запись и базу этого пользователя, поэтому PIN предыдущего аккаунта на новом не действует.

**Сброс при проблемах.** Удалить PIN без входа: DevTools → Application → IndexedDB → `logbook:device` → `meta` → удалить запись `offline_session:<user_id>` (журнал при этом сохранится). Полный сброс устройства — удалить `logbook:device` (потребуется повторная регистрация устройства). Не удаляйте `logbook:user:<id>` вручную, если в очереди есть несинхронизированные записи.

**Ограничения и остаток.** PIN защищает интерфейс, но не шифрует данные на диске (SYN-03/OQ-09); срок офлайн-сессии 30 дней — OQ-27; после 3 неудачных попыток на сервере блокировка учётной записи не выполняется (это политика IdP/ADM). AUTH-03 закрыт; остаются SYN-03 (шифрование/компенсация) и OQ-27 (утверждение срока).


### 3.10. Демонстрационный комплект

```powershell
npm run demo:start
npm run demo:reset
npm run demo:permits
```

`demo/start.ps1` собирает shared, выполняет seed, запускает API/web и открывает браузер. `demo:reset` удаляет только `.data/pglite` (с подтверждением) и заново сеет данные. `demo:permits` импортирует `demo/permits.csv` от администратора.

Сценарий презентации — `demo/presentation.md`; ограничения — `demo/README.md`.


### 3.11. Админ-контур и отдельный origin (ADR-14)

Админ-панель — тот же production-бандл `apps/web`, но с оболочкой `/admin/*` и доступом только для роли `admin` (UI-guard + `@Roles('admin')` на API). Экраны: обзор, пользователи, роли, журналы и гранты, устройства, импорт нарядов CSV/JSON, хранение (retention/аудит/backup/архив), экспорт WORM PDF/CSV, аудит.

```bash
# основной origin (оперативный журнал)
CORS_ORIGIN=https://logbook.example.com
# отдельный origin админки (production: https, не равен CORS_ORIGIN)
ADMIN_ORIGIN=https://admin.logbook.example.com

# сборка того же бандла для админ-домена
VITE_ADMIN_ORIGIN=https://admin.logbook.example.com npm run build:web
```

На admin-домене `/` автоматически редиректит на `/admin`; вход — обычный (OIDC/dev), но сессия живёт в cookie-jar админ-домена (host-only, SameSite=Lax) и не пересекается с операционной. CSRF-токен для админки приходит в `GET /v1/me.csrf_token`, потому что cookie API-домена недоступна JS на другом origin. API разрешает оба origin в CORS; в production `ADMIN_ORIGIN` обязан быть https и не может совпадать с `CORS_ORIGIN` (fail-closed).

Если поддомен/DNS/сертификат ещё не готовы (ADR-14, этап 6), тот же контур доступен по `/admin` на основном origin — роль admin проверяется в UI и API. Ограничения: CSP/HSTS для admin-origin — AUTH-05; сроки хранения — OQ-05/OQ-18; удаление пользователей не реализовано (только блокировка/деактивация), правила владения данными — OQ-18.

Действия администратора аудируются: `user.create`, `user.update`, `user.revoke_sessions`, `device.revoke`, `journal.*`, `permit.import`, `retention.*`, `backup.checkpoint` и др. Смотреть — раздел `/admin/audit` или `GET /v1/audit?action=...`.

### 3.11. Audit outbox и восстановление journal_seq (REP-06)

Аудит пишется в `audit_outbox` **в той же транзакции**, что и бизнес-изменение;
delivery-worker (25 мс) переносит его в `audit_events` одной транзакцией
(advisory lock + INSERT + DELETE) — потеря события при крахе исключена. Чтение
`/v1/audit` и `/v1/admin/audit/verify` вызывает `flushPending`; при graceful
shutdown очередь доставляется. Мониторить `audit outbox delivery failed`.

`journal_seq` с `0016` выдаётся блоками из per-journal sequence
(`journal_seq_<uuid>`); записи вставляются с положительным номером сразу.
Sequence нетранзакционна: полный откат батча/авария может оставить разрыв —
**политика t29**, дубликатов и отрицательных номеров нет. `journal_counters`
остаётся legacy/backfill (`0015`), в горячем пути не участвует. Upgrade
0014→0016 backfill-ит counters и синхронизирует sequence с `max(journal_seq)`
(тест `migration-upgrade.spec`). Гарантия непрерывности потребовала бы
сериализации и p95 ≈620 мс; при юридическом требовании — waiver.

### 3.12. Батчевый push и нагрузочный прогон

`POST /v1/sync/push` обрабатывает весь батч (≤50 ops) в одной транзакции с
savepoint на операцию; `journal_seq` выдаётся блоками из per-journal sequence
(`journal_seq_<uuid>`, миграции 0013/0014), записи/change_log/idempotency
вставляются bulk-запросами. Аудит пишется коалесцирующим writer-ом после commit
(один advisory lock/INSERT на поток); audit reads и `/v1/admin/audit/verify`
флашат очередь. Мониторить `audit async writer failed` в логах API.

Рекомендации: `DATABASE_POOL_MAX ≥ VU + 8` (для 20 VU — 28), не отключать
`synchronous_commit`. Повторный прогон QA-06:

```bash
BASE_URL=http://127.0.0.1:3104/v1 MIX=push:100 DURATION_MS=30000 \
  CONCURRENCY=20 RAMP_MS=3000 STRICT=1 node scripts/pg/loadtest.mjs
# push 2295, p50 192,5 / p95 349,1 / p99 1615 / max 2082 мс, 0 ошибок, 76,1 rps
# All QA-06 thresholds passed.
```

Результат t17: порог push 50 ops p95 ≤400 мс выполнен (279,6 мс; до исправления
5 306,7 мс). Смешанный профиль: push p95 372 мс, read/changes под высокой
push-нагрузкой требуют отдельной оптимизации (отчёт 37). `journal_seq` в 0015 назначается из `journal_counters` (gapless для fresh DB); upgrade 0014→0015 требует backfill counters — известный блокер B-10 (`38_Релизный_отчёт.md`).

## 4. Тесты

```bash
npm test
npm run test:e2e        # browser E2E + axe a11y; нужен PG/E2E_DATABASE_URL и собранный dist
```

Результат на текущей итерации:

| Пакет | Тестов | Статус |
|---|---|---|
| `@logbook/shared` | 28 | pass |
| `@logbook/api` | 125 | pass |
| `@logbook/web` | 153 | pass |
| **Итого** | **306** | **pass** |

Проверки:

- HLC: формат, порядок, монотонность, дрейф.
- UUID v7 и фиксированные seed-ID.
- Zod-схемы записи и sync-батча.
- Миграции 0001…0016: применение, идемпотентность, наличие таблиц.
- Seed: детерминизм, повторный запуск, статусы записей.
- `GET /v1/health` через Nest + Supertest.
- Auth: dev-login, `/me`, CSRF, logout, отзыв сессии.
- AUTH-04/05: security headers/CSP API, HSTS (production unit), rate limit auth/API (`429 E-RATE-01`, `Retry-After`), idle timeout с отзывом сессии.
- SCA: `npm audit` 0 high/critical; 3 moderate только dev/build Workbox — waiver `docs/security/SCA_WAIVER.md`.
- Qualified ЭП: контракт sign/verify с тестовым HTTP-провайдером (успех, tamper, HTTP-ошибка, invalid JSON, timeout, `E-SIG-02`), ручная подпись и verify в API.
- OIDC harness: реальный HTTP IdP (discovery/authorize/token/JWKS), redirect URI, PKCE, MFA admin (`acr`/`amr`), отказ `E-OIDC-04`, `E-OIDC-02` при недоступном IdP.
- OIDC: config, authorize с PKCE (state/nonce/S256), e2e-callback с подменённым IdP,
  проверка `id_token`, replay state, отказ непровиженному пользователю.
- Env: production-гейты (DATABASE_URL обязателен, oidc, cookie secret, https, ЭП-fail-closed), JIT.
- PKCE S256 (вектор RFC 7636) и JWT: подпись, tamper, nonce, audience, exp, alg.
- Устройства: идемпотентная регистрация, ротация ключа, push с/без `X-Device-Key`,
  отзыв устройства и его сессий, права на отзыв.
- ЭП: авто-подпись визы и проверки журнала, проверка подписи, подмена → `invalid`,
  unverify → `revoked`, запрет чужой подписи.
- Sync: create, duplicate, merge C-01…C-12, конфликт, tombstone, `changes`.
- Journal: видимость по ролям, verify/unverify/restore, конфликты.
- Permits: CSV-импорт, идемпотентность, `501` PDF.
- Audit: hash-цепочка и чтение; admin: пользователи и отзыв сессий.
- Dexie: 19 stores (v5, включая `journals`, `shifts`, `groundings`, `supervisor_cache` и per-user БД), транзакция entry+outbox, индексы `journal_id`.
- Web: create/update/delete записи, coalesce create, changes/tombstones.
- Web: push, `duplicate=true`, конфликт, backoff, changes cursor, offline.
- Web: регистрация устройства в sync-bootstrap, передача `device_key`.
- Web: экраны входа (dev и OIDC) и ленты через Testing Library.
- Web: `changes`-конфликт, `applySnapshot` templates, `dead` после 10 попыток.
- API: C-08 consent, C-09 annulled, C-10 invalid merge, серверные ревизии.
- API: FR-PRM-11 `participant`/`all`.
- API: `journal_seq`, `event_type`/`event_data`, `journal_reviews`, CSV.
- API: мультижурнальность — журналы/права, независимый `journal_seq`, изоляция, визы и CSV по журналу, запрет смены журнала.
- API: смена — сдача/приёмка/отклонение, запрет своей смены, дубль окна, офлайн sync create→accept, stale-конфликт, changes, 2 подписи и их verify, аудит.
- API: переключения — структурированные операции/проверки, неизвестная операция/пустой бланк, legacy-форма; заземления — apply/remove, конфликты повторов, неизменяемость события, реестр/доступ, аудит, changes.
- API: retention — политика/cutoff, run + audit_verify, детект broken-chain, hard-delete old/recent; WORM export — PDF/CSV, manifest/hash, ЭП+verify, signed URL, tamper/expired/401, WORM UPDATE/DELETE; архив и backup checkpoint.
- API: retention scheduler (REP-05) — расчёт UTC, идемпотентность 1/день, TTL change_log/export_jobs без удаления записей журнала, алерты audit_broken/run_failed/webhook.
- API: PDF наряда — генерация/детерминированность, signed URL и заголовки, аудит, tamper/expired/версия/без сессии, внешний redirect; JSON-адаптер импорта идемпотентен, ошибки строк.
- Web: PDF наряда (generated/external), deep link и метки в списке S-07.
- Web: Dexie v2→v3→v4→v5 (журналы, смены, заземления, кэш руководителя), фильтр по журналу в S-01, выбор журнала в S-03, печать/визы по журналу.
- Web: S-15 «Смены» — сдача, приёмка/отклонение, конфликт и сверка с сервером, печатная форма акта.
- Web: S-16 «Заземления» — реестр, фильтры журнал/состояние, печать; форма переключений с операциями/проверками.

Дополнительно:

```bash
npm run typecheck     # все пакеты
npm run build         # shared + api + web
```

Сборка web: JS 527,01 КБ (gzip 151,64 КБ), precache 11 файлов / 542,95 КиБ — срез t8 (25.11.2026). Актуальные числа и полный прогон — в README и отчётах 28–34; после t17 размер пересобирается.

---

## 5. Структура

```
apps/api            NestJS 11, REST /v1, sync/merge
apps/web            React 18 + Vite + Dexie + синхронизация (PWA)
packages/shared     типы, Zod, HLC, UUID v7, seed-data
db/migrations       0001…0016
db/seed             детерминированный seed
db/postgres         TLS, compose-primary/replica, эксплуатация PG 15
scripts/pg          bootstrap PG 15, backup/restore, PITR, HA, smoke, нагрузка
poc/                прототипы G1–G3, вне поставки
```

---

## 6. Окружение

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `PORT` | порт API | 3001 |
| `DATABASE_URL` | PostgreSQL; если задан — PGlite не используется. **Обязателен в production** (fail-closed) | — |
| `DATABASE_SSL_MODE` | TLS к PostgreSQL: `disable` (localhost), `require`, `verify-full` | `disable` |
| `DATABASE_SSL_CA_PATH` | CA-сертификат для `verify-full` | — |
| `DATABASE_POOL_MAX` | размер пула соединений на инстанс API | `10` |
| `PGLITE_DIR` | каталог PGlite | `.data/pglite` |
| `RUN_MIGRATIONS_ON_START` | миграции при старте API | true |
| `DEV_SEED_PASSWORD` | пароль dev-пользователей | `Logbook!2026` |
| `COOKIE_SECRET` | подпись cookie | dev-значение |
| `SESSION_TTL_DAYS` | абсолютный срок сессии | `30` |
| `SESSION_IDLE_MINUTES` | idle timeout (AUTH-04); production ≤ 120 | `30` |
| `RATE_LIMIT_ENABLED` / `RATE_LIMIT_WINDOW_SECONDS` / `RATE_LIMIT_MAX` | API rate limit на IP | `true` / `60` / `300` |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` / `AUTH_RATE_LIMIT_MAX` | лимит auth-эндпоинтов на IP | `900` / `20` |
| `HSTS_MAX_AGE_SECONDS` | HSTS в production (0 отключает) | `31536000` |
| `TRUST_PROXY` | доверять `X-Forwarded-*` за nginx | `false` |
| `CORS_ORIGIN` | origin web | `http://localhost:5173` |
| `ADMIN_ORIGIN` | отдельный origin админки (ADR-14); production: https и ≠ `CORS_ORIGIN` | — |
| `ENV_FILE` | путь к env-файлу (systemd/секреты вне репозитория) | `<корень>/.env` |
| `MIGRATIONS_DIR` | альтернативный каталог миграций | `db/migrations` |
| `PERMIT_VISIBILITY_MODE` | FR-PRM-11: `all` или `participant` | `all` |
| `PERMIT_PDF_SECRET`, `PERMIT_PDF_TTL_SECONDS`, `PERMIT_PDF_PUBLIC_BASE_URL` | signed URL PDF наряда (OQ-03) | `COOKIE_SECRET` / 900 / — |
| `EXPORT_SIGNING_SECRET`, `EXPORT_URL_TTL_SECONDS`, `EXPORT_PUBLIC_BASE_URL` | signed URL WORM-экспорта журнала | `COOKIE_SECRET` / 900 / — |
| `RETENTION_YEARS` | политика хранения/архива (OQ-05/OQ-18 не утверждены) | `3` |
| `RETENTION_SCHEDULER_ENABLED` / `RETENTION_SCHEDULE_UTC` | ежедневный scheduler + время UTC | `true` / `02:00` |
| `RETENTION_OVERDUE_HOURS` | алерт, если успешный run старше N ч | `26` |
| `CHANGE_LOG_RETENTION_DAYS` / `EXPORT_JOB_RETENTION_DAYS` | TTL change_log / не-WORM export_jobs | `90` / `7` |
| `RETENTION_ALERT_WEBHOOK_URL` / `_TIMEOUT_MS` | optional webhook алертов | — / `5000` |
| `AUTH_PROVIDER` | `dev` (пароль) или `oidc` (Authorization Code + PKCE) | `dev` |
| `DEV_LOGIN_ENABLED` | выключатель dev-входа | `true` (в production запрещён) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` | регистрация клиента IdP | — |
| `OIDC_ALLOWED_ALGORITHMS` | разрешённые алгоритмы `id_token` | `RS256` |
| `OIDC_REQUIRE_MFA_FOR_ADMIN` / `OIDC_MFA_ACR_VALUES` | MFA администратора (`acr`/`amr`), значения acr | `true` / `mfa` |
| `OIDC_JIT_PROVISION`, `OIDC_JIT_DEPARTMENT_ID` | JIT-провижининг пользователей | `false` / — |
| `SIGNATURE_PROVIDER` | `none` / `simple` / `qualified` | `none` |
| `SIGNATURE_SECRET`, `SIGNATURE_KEY_ID` | ключ `simple`-ЭП | — / `logbook-simple-v1` |
| `SIGNATURE_AUTO_SIGN` | авто-подпись виз и проверок (`simple`) | `true` |
| `SIGNATURE_QUALIFIED_ENDPOINT`, `_TOKEN` | сервис КЭП для `qualified` | — |
| `VITE_API_URL` | база API для web | `/v1` |
| `VITE_ENABLE_DEV_LOGIN` | быстрый dev-вход | true (скрыт в production) |
| `VITE_ENABLE_ON_DEVICE_ASR` | on-device ASR | false |
| `VITE_ENABLE_WEB_SPEECH` | Web Speech | false |

---

## 7. Технические решения и ограничения

| Решение | Причина |
|---|---|
| NestJS 11, не 12 | Nest 12 поставляется как ESM и не грузится в CJS-тестах/tsx; сработал fallback из матрицы рисков |
| PGlite | нет Docker/PostgreSQL в окружении; production — `pg` |
| Jest с `--experimental-vm-modules` | PGlite загружает WASM динамическим импортом |
| `@Global()` DbModule | health-контроллер получает `DB` без дублирования импорта |
| `user_credentials` | dev-аутентификация (ADR-22); в production заменяется OIDC (ADR-23) |
| `AUTH_PROVIDER` | один код поддерживает dev и OIDC; production-профиль валидируется fail-closed |
| `document_signatures` | `simple` — HMAC (не КЭП), `qualified` — адаптер к сервису КЭП; OQ-04 открыт |
| `devices.install_id` | идемпотентная регистрация; `device_key` привязывает push к устройству |

### TODO

- `TODO(OQ-02)`: согласовать IdP, MFA-политику и redirect URIs; OIDC-код готов, интеграция с реальным IdP не выполнена.
- `TODO(OQ-03)`: подтверждение владельцем нарядов; адаптеры CSV/JSON и signed URL PDF готовы (t6).
- `TODO(ADR-14)`: отдельный origin админки — **закрыто в t8** (`ADMIN_ORIGIN`, `/admin/*`, отдельная admin-сборка); остаётся DNS/сертификат поддомена.
- `TODO(G1)`: on-device ASR за флагом, после PoC.
- `TODO(OQ-10)`: Web Speech выключен.
- `TODO(ADR-03)`: кастомный SW для Background Sync — **закрыто в t10** (Background/Periodic Sync, см. 3.6.1); остались квоты/вытеснение (SYN-01) и tombstones/resync (SYN-06).
- `TODO(OQ-21)`: per-user IndexedDB — **закрыто в t10** (`logbook:user:<id>` + кэш руководителя); требуется письменное подтверждение заказчика/ИБ по OQ-21.
- `TODO(C-08)`: API серверной коррекции времени отсутствует; consent-политика готова.
- `TODO(C-09)`: нет push/email уведомления руководителю; есть conflict + audit.
- `TODO(Phase B)`: PoC-стенды G1/G2/G3.
- `TODO(Phase C)`: приёмка на PostgreSQL 15 выполнена на портативном кластере 15.15 (TLS, миграции 0001…0014 на срезе t15, seed, smoke 20 проверок, backup/restore, PITR, HA-дрилл); push 50 ops p95 349,1 мс при 20 VU подтверждён после t29 (отчёты 37/40); текущее дерево содержит 0016 — нужен повторный чистый прогон и restore в t28; осталось повторить в Docker/Linux (ADM-07).
- `TODO(OQ-04)`: юридическая значимость ЭП; `simple` — только целостность, `qualified` не проверен на реальном сервисе КЭП.
- `TODO(shift handover)`: двухсторонняя сдача/приёмка смены — **закрыто в t4/t9** (`0009`, `/shifts`, S-15).
- `TODO(мультижурнальность)`: `journal_id` и отдельная нумерация — **закрыто в t3** (`0008`, `/journals`, права, независимый `journal_seq`).
- `TODO(OQ-18)`: ежедневный scheduler, TTL change_log/export_jobs и алерты — **закрыто в t24** (`0017`, `retention-scheduler`/`retention-alerts`); автоудаление архивных данных по утверждённой политике остаётся внешним решением OQ-05/OQ-18.
- `TODO(auth-ui)`: экран устройств и подпись/проверка подписей — **закрыто в t8/t9**; остаётся индикатор «не КЭП» в печатных формах и OQ-04.

### 7.1. Открытые пункты эксплуатации

- Docker/Linux-профиль не прогнан (в окружении нет Docker) — приёмка на чистой VM по [35_Руководство_по_установке.md](35_Руководство_по_установке.md).
- Production-гейт `env.ts` требует `DATABASE_URL`: без него API не стартует (`Invalid environment configuration: DATABASE_URL: production требует DATABASE_URL`). PGlite/память допустимы только при `NODE_ENV=development|test`.
- Rate limit, idle timeout и security headers/CSP реализованы в API (t22, `security.spec`); `deploy/nginx/nginx.conf` проверен исполняемо (`scripts/security/verify-nginx.ps1`, `nginx -t` successful). Остаются `/metrics` и алерты (ADM-05); 3 moderate npm audit только в dev/build Workbox — waiver `docs/security/SCA_WAIVER.md`.
- Реальный IdP (OIDC credentials, MFA-политика) и аккредитованный сервис КЭП не предоставлены: контракты/harness проверены, production-вход и qualified ЭП остаются внешними блокерами (`docs/security/REP-01_02_WAIVER.md`).
- Автоматический failover не реализован; retention scheduler/алерты — закрыто в t24 (для нескольких реплик нужен внешний timer).
- Актуальный остаток, waivers и блокеры — [24_Остаток_разработки.md](24_Остаток_разработки.md) v3.0; FR-покрытие — [07_Матрица_трассируемости.md](07_Матрица_трассируемости.md) v3.0; релиз — [38_Релизный_отчёт.md](38_Релизный_отчёт.md) (**FAIL**).

---

## 8. Что дальше

1. Завершить ремонт t21–t26: AUTH-03 (t21), AUTH-04/05 + SCA (t22 — **закрыто**), атомарность аудита/`journal_seq` (t23), retention scheduler/алерты (t24 — **закрыто**, OQ-05/OQ-18 внешние), реальный IdP/КЭП (t25 — контракты/harness готовы; **внешние блокеры** OQ-02/OQ-04, `docs/security/REP-01_02_WAIVER.md`), E2E/a11y/Linux-Docker (t26).
2. Повторная приёмка t28 на текущем дереве (0015): тесты/типы/сборка, чистая PG 15 (15 миграций, seed, smoke), backup/restore, нагрузка, SCA, docs; вердикт PASS/FAIL.
3. Релизная интеграция t16 и согласование с заказчиком; waivers W-01…W-07 подписываются только владельцами.
4. Внешние решения: OQ-02 (IdP/MFA), OQ-04 (ЭП/КЭП), OQ-05/OQ-18 (retention), G1/G2; после них — production-пилот.
5. PoC G1–G3 (ASR) — после решения по модели/корпусу/D1–D7.
6. Обучение и приёмочный пакет (OQ-30); Linux/Docker/nginx — по `35_Руководство_по_установке.md`.

---

## 9. PostgreSQL 15: приёмка, backup/restore, HA

Полный отчёт — [29_Отчёт_PostgreSQL_Production.md](29_Отчёт_PostgreSQL_Production.md),
эксплуатация TLS/HA — [db/postgres/README.md](db/postgres/README.md).

Локальный стенд без Docker (PostgreSQL 15.15 + TLS + WAL-архив):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pg/bootstrap-pg15.ps1
# DATABASE_URL=postgres://logbook:logbook@127.0.0.1:55432/logbook

$env:DATABASE_URL='postgres://logbook:logbook@127.0.0.1:55432/logbook'
$env:DATABASE_SSL_MODE='verify-full'
$env:DATABASE_SSL_CA_PATH='.data/pg15/certs/server.crt'
npm run db:migrate     # 0001…0016
npm run db:seed

# smoke (20 проверок), backup/restore, PITR, HA, нагрузка
node scripts/pg/smoke.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pg/backup.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pg/restore.ps1 -Dump .data\pg15\backups\<dump>
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pg/pitr-drill.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pg/replica-drill.ps1
node scripts/pg/scale-fixture.mjs
node scripts/pg/loadtest.mjs
```

Фактические результаты: приёмочный срез t15 — 14 миграций (`0001…0014`), чистая БД PostgreSQL 15.15, seed `users=3/permits=3/entries=5`, smoke 20/20. Текущее дерево (27.11.2026) содержит **0016** (`audit_outbox` + sequence-политика `journal_seq`) и требует повторной приёмки t28; 16 миграций на чистой БД в этом срезе не прогонялись. t29: push 50 ops p95 349,1 мс при 20 VU (порог 400), 0 ошибок; t17 — 279,6 мс; чистые смешанные прогоны 25.11.2026 — read p95 72,6/75,4 мс, changes 143,0/148,7 мс, push 331,4/357,5 мс, пороги QA-06 пройдены. Backup/restore на 0014 проверен после исправления `restore.ps1` (проверка `pg_sequences`); для 0016 нужен повторный restore-тест в t28. Docker/Linux-профиль не запускался. **Release t15 — FAIL, production readiness не заявляется** ([38](38_Релизный_отчёт.md)).

Отчёты — [23_Отчёт_Правила_ЭОЖ.md](23_Отчёт_Правила_ЭОЖ.md),
[26_Отчёт_Auth_Platform.md](26_Отчёт_Auth_Platform.md),
[29_Отчёт_PostgreSQL_Production.md](29_Отчёт_PostgreSQL_Production.md).

---

## 10. Установка и эксплуатация production

Полная процедура — [35_Руководство_по_установке.md](35_Руководство_по_установке.md):

| Раздел руководства | Содержание |
|---|---|
| §2–§4 | требования, варианты (Windows/Linux/Docker), сборка и состав дистрибутива |
| §5 | `.env`, production-профиль, секреты, fail-closed гейты, `VITE_*` |
| §6–§7 | PostgreSQL 15 (TLS, миграции, bootstrap-администратор, справочники), nginx/systemd |
| §8–§10 | установка на Windows/Linux, Docker (БД и шаблон образа) |
| §11–§14 | первый запуск и приёмка, обновление/откат, backup/restore/PITR/HA, мониторинг |
| §15–§16 | диагностика, вывод из эксплуатации |
