# Контракт API ЭОЖ «Logbook», v1

| Параметр | Значение |
|---|---|
| Версия API | `/v1` |
| Формат | JSON UTF-8, `application/json` |
| Транспорт | HTTPS, HTTP/2, сжатие `br`/`gzip` |
| Аутентификация | HttpOnly cookie сессии (предпочтительно) или `Authorization: Bearer` |
| Дата | 23.11.2026 |
| Связанные документы | `05_Модель_данных.md`, `04_Архитектурное_описание.md` |

---

## 1. Общие правила

### 1.1. Заголовки

| Заголовок | Направление | Назначение |
|---|---|---|
| `Authorization: Bearer <token>` | запрос | Альтернатива cookie-сессии |
| `X-CSRF-Token` | запрос | Обязателен для cookie-сессии при мутациях |
| `X-Request-Id` | запрос/ответ | Трассировка; генерируется клиентом, если отсутствует — сервером |
| `Idempotency-Key` | запрос | Для REST-мутаций (не для sync) |
| `If-None-Match` / `ETag` | запрос/ответ | Справочники, карточки |
| `Retry-After` | ответ | При `429` и `503` |
| `X-RateLimit-*` | ответ | Лимиты |

### 1.2. Время

Все метки — ISO 8601 UTC с миллисекундами: `2026-11-23T09:15:30.123Z`. Каждый ответ содержит `server_time`.

### 1.3. Ошибки

Единый формат:

```json
{
  "error": {
    "code": "E-VAL-01",
    "message": "Запись не сохранена: опишите работу (10–2000 символов)",
    "fields": { "text": "Слишком короткий текст" },
    "request_id": "req_01HXYZ..."
  }
}
```

| Код | HTTP | Значение | Действие клиента |
|---|---|---|---|
| `E-AUTH-01` | 401 | Сессия недействительна | Refresh, затем вход; очередь сохранить |
| `E-AUTH-02` | 403 | Нет прав | Не повторять |
| `E-VAL-01` | 400 | Ошибка валидации | Показать поля, операцию в `dead` |
| `E-VER-01` | 409 | Конфликт версий | Принять `merged_entry` |
| `E-PRM-01` | 422 | Наряд аннулирован / недоступен | Показать, предложить изменить |
| `E-PRM-02` | 422 | Наряд не найден | `binding_status = not_found` |
| `E-RATE-01` | 429 | Лимит | Пауза по `Retry-After` |
| `E-LIM-01` | 413 | Батч слишком большой | Разбить |
| `E-APP-01` | 426 | Версия клиента устарела | Требовать обновление |
| `E-CURSOR-01` | 410 | Курсор устарел (старше 90 дней) | Полная пересинхронизация |
| `E-SRV-01` | 500 | Внутренняя ошибка | Повтор с backoff |
| `E-SRV-02` | 503 | Недоступно | Повтор с backoff |

### 1.4. Пагинация

Курсорная: `?cursor=<opaque>&limit=<1..100>`. Ответ: `items`, `next_cursor` (`null` — конец), `has_more`. По умолчанию и максимум — 100; исключение — `/sync/changes` (до 200, см. §4.1).

### 1.5. Идемпотентность REST

Для `POST`/`PATCH` обязателен `Idempotency-Key` (UUID). Повтор с тем же ключом в течение 24 ч возвращает сохранённый ответ.

### 1.6. Версионирование

- Мажорная версия — в пути (`/v1`).
- Сервер поддерживает текущую и предыдущую мажорные версии 90 дней.
- Новые необязательные поля игнорируются старыми клиентами; новые обязательные — только с дефолтом.

---

## 2. Аутентификация

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/v1/auth/authorize` | Редирект на IdP (OIDC + PKCE) |
| `GET` | `/v1/auth/callback` | Callback IdP, установка cookie сессии |
| `POST` | `/v1/auth/session` | Обновление сессии (refresh) |
| `POST` | `/v1/auth/logout` | Завершение сессии |
| `GET` | `/v1/me` | Профиль, роль, подразделение, настройки |
| `GET` | `/v1/devices` | Устройства пользователя |
| `DELETE` | `/v1/devices/{id}` | Отзыв устройства |

**Ответ `/v1/me`:**

```json
{
  "server_time": "2026-11-23T09:15:30.123Z",
  "user": {
    "id": "0193f0c4-...",
    "full_name": "Иванов Иван Иванович",
    "role": "worker",
    "department": { "id": "...", "name": "Участок №3" },
    "status": "active"
  },
  "session": {
    "offline_valid_until": "2026-12-23T09:15:30.123Z",
    "refresh_expires_at": "2026-12-23T09:15:30.123Z"
  },
  "features": { "voice": true, "web_speech": false, "attachments": false, "supervisor_cache": true }
}
```

**Правила:** access ≤ 15 мин; refresh 30 дней скользящий, device-bound, ротация при каждом использовании; при компрометации — отзыв устройства.

`features.supervisor_cache` (ADR-16/SYN-02): `true` для `supervisor`/`admin` — клиент держит офлайн-кэш последних 7 дней журналов подразделения с бюджетом 15 МиБ (доля на журнал). Для `worker`/`auditor` — `false`. Клиент дополнительно проверяет роль, поэтому старый API без флага не включает кэш.

---

## 3. Чтение

### 3.1. Записи

`GET /v1/entries?from&to&permit_id&author_id&status&journal_id&cursor&limit`

| Параметр | Тип | Ограничение |
|---|---|---|
| `from`, `to` | ISO date | Диапазон `performed_at` |
| `permit_id` | uuid | — |
| `author_id` | uuid | Только для supervisor/admin |
| `journal_id` | uuid | Фильтр по журналу; без параметра — все доступные журналы |
| `status` | enum | `active` (по умолчанию) / `deleted` (только admin) |
| `cursor`, `limit` | string, int | `limit ≤ 100` |

Область видимости по журналам (JRN-03): `worker`/`supervisor` видят `main` и журналы, где есть `journal_members`; `admin`/`auditor` — все журналы. Запрос `journal_id` без доступа → `403 E-AUTH-02`.

`GET /v1/entries/{id}` — запись с ревизиями (для автора, руководителя, админа). В ответе всегда есть `journal_id` и `journal_seq`; `journal_id` неизменяем.

### 3.2. Наряды (OQ-03)

`GET /v1/permits?updated_since&status&site_id&cursor&limit`
`GET /v1/permits/{id}` — карточка, включая `external_url` (deep link), `pdf_url`, `pdf_hash`, `pdf_size_bytes`, `pdf_generated_at`, `pdf_source`.

`POST /v1/permits/{id}/pdf-url` — выпускает подписанную ссылку (TTL ≤ 900 с, HMAC):

```json
{
  "permit_id": "...", "source": "generated",
  "url": "/v1/permits/pdf/<id>?token=...",
  "expires_at": "2026-11-25T09:15:00.000Z",
  "hash": "…64…", "size_bytes": 223553,
  "external_url": "https://permits.example.local/123",
  "deep_link": "https://permits.example.local/123",
  "pdf_url": null
}
```

`source=generated` — PDF формируется сервером из карточки (встроенный UTF-8 шрифт, русский текст), hash стабилен и сохраняется в `permits.pdf_hash`; `source=external` — источник дал `pdf_url`, ссылка Logbook перенаправляет на него (302). `GET /v1/permits/pdf/{id}?token=...` требует сессию, проверяет подпись/срок/`permit.version` и отдаёт `application/pdf` (или 302 на внешний PDF); доступ проверяется по `PERMIT_VISIBILITY_MODE`, скачивание и выпуск ссылки пишутся в аудит (`permit.pdf_url`, `permit.pdf_download`). Просроченная/подменённая ссылка — 403, ссылка после изменения наряда — 400 `E-VAL-01`.

Импорт: `POST /v1/admin/permits/import` `{ "source_id": "...", "csv": "..." }` (CSV-адаптер) или `{ "source_id": "...", "records": [ ... ] }` (JSON-адаптер источника). Записи содержат те же поля, что CSV, плюс `pdf_url`/`pdf_hash`; импорт идемпотентен по `(source_id, external_id)`, ошибки строк возвращаются в `errors[]`, `external_url` используется как deep link. `GET /v1/admin/imports` — журнал импортов.

### 3.3. Справочники

`GET /v1/dictionaries/snapshot` — атомарный снимок:

```json
{
  "server_time": "...",
  "snapshot_id": "ds_2026_11_23_01",
  "work_types": { "version": 12, "items": [ ... ] },
  "sites": { "version": 8, "items": [ ... ] },
  "templates": { "version": 4, "items": [ ... ] },
  "reasons": { "version": 3, "items": [ ... ] },
  "departments": { "version": 2, "items": [ ... ] },
  "journals": {
    "version": 2,
    "items": [
      {
        "id": "01930000-0000-7000-8000-000000001001",
        "journal_key": "main",
        "name": "Основной оперативный журнал",
        "description": null,
        "active": true,
        "sort_order": 10,
        "access_level": "write"
      }
    ]
  }
}
```

Клиент применяет снимок целиком, не смешивая версии. `journals` содержит только журналы, доступные текущему пользователю; `version` растёт при создании/изменении журнала.

### 3.6. Журналы (мультижурнальность, JRN-03)

| Метод | Путь | Роль | Назначение |
|---|---|---|---|
| `GET` | `/v1/journals` | все | Список доступных журналов (`access_level`: `read`/`write`/`manage`) |
| `GET` | `/v1/journals/{id}` | доступ | Карточка журнала |
| `GET` | `/v1/admin/journals/{id}/members` | admin | Гранты журнала |
| `POST` | `/v1/admin/journals` | admin | Создать журнал `{journal_key, name, description?, sort_order?, active?}` → 201 |
| `PATCH` | `/v1/admin/journals/{id}` | admin | Изменить `name`, `description`, `active`, `sort_order` |
| `PUT` | `/v1/admin/journals/{id}/members/{userId}` | admin | Выдать доступ `{access_level: "read"\|"write"\|"manage"}` |
| `DELETE` | `/v1/admin/journals/{id}/members/{userId}` | admin | Отозвать доступ |

Ошибки: неизвестный журнал — `404 E-NOT-01`; нет доступа — `403 E-AUTH-02`; неактивный журнал для новой записи — `422/400 E-VAL-01`; дубликат `journal_key` — `400 E-VAL-01`.

### 3.7. Визы и экспорт журнала
`GET /v1/journal/reviews?from&to&journal_id&limit` — supervisor/admin; supervisor видит визы доступных ему журналов.
`POST /v1/journal/reviews` `{journal_id?, period_start, period_end, remarks?}` — 201; без `journal_id` — `main`. `entries_count` и `content_hash` считаются только по записям выбранного журнала.
`POST /v1/journal/reviews/{id}/sign`, `GET /v1/journal/reviews/{id}/signatures`, `POST /v1/entries/{id}/sign` — подпись визы/записи через настроенный ЭП-адаптер.

`GET /v1/journal/export?from&to&journal_id&format=csv` — CSV; без `journal_id` выгружаются все доступные журналы, с `journal_id` — только выбранный. В шапке CSV добавлен столбец `journal_key` (в конце, обратная совместимость); при фильтре печатается строка `# Журнал: <name> (<key>)`.

### 3.8. Смены (сдача-приёмка, JRN-02)

| Метод | Путь | Роль | Назначение |
|---|---|---|---|
| `GET` | `/v1/shifts?journal_id&status&from&to&limit` | все | Смены: supervisor — доступные журналы, worker — только свои сдачи/приёмки |
| `GET` | `/v1/shifts/{id}` | доступ | Смена + подписи в `signatures[]` |
| `POST` | `/v1/shifts` | supervisor/admin | Сдать смену (передаётся окно и комментарий) → 201 |
| `POST` | `/v1/shifts/{id}/accept` | supervisor/admin | Принять смену (принимающий ≠ сдающий) → 201 |
| `POST` | `/v1/shifts/{id}/reject` | supervisor/admin | Отклонить смену с причиной → 201 |

```json
POST /v1/shifts
{
  "journal_id": "01930000-0000-7000-8000-000000001001",
  "shift_date": "2026-11-24",
  "period_start": "2026-11-24T05:00:00.000Z",
  "period_end": "2026-11-24T17:00:00.000Z",
  "handover_comment": "Смена сдана, журнал проверен, замечаний нет"
}
→ 201 {
  "id": "0193...", "status": "handed_over", "version": 1,
  "handed_over_by": "...", "entries_count": 4,
  "entries_hash": "…64…", "content_hash": "…64…"
}
```

`POST /v1/shifts/{id}/accept` → `{ "action": "accept", "comment": "Принято" }`; `POST .../reject` → `{ "action": "reject", "rejection_reason": "..." }`. Ошибки: своя смена — `403 E-AUTH-02`; повторная приёмка/отклонение — `409 E-VER-01`; нет доступа к журналу — `403`; период/комментарий — `400 E-VAL-01`; дубль активной смены на окно — `409 E-VER-01`.

Правила: смену принимает другой пользователь; сдача и приёмка подписываются ЭП-адаптером (`document_signatures.entity_type='shift'`, версии 1 и 2); подпись сдачи остаётся действительной после приёмки; каждая операция попадает в аудит (`shift.handover/accept/reject`) и в `change_log` (`entity_type='shift'`) для других устройств.

### 3.9. Реестр заземлений (JRN-06)

| Метод | Путь | Роль | Назначение |
|---|---|---|---|
| `GET` | `/v1/groundings?journal_id&site_id&state&limit` | все (по доступу к журналу) | Реестр: `applied` / `removed` |
| `GET` | `/v1/groundings/{id}` | доступ к журналу | Строка реестра |
| `POST` | `/v1/sync/push` (entry `event_type='grounding'`) | автор записи | Установка/снятие заземления |

Строка реестра создаётся сервером из события заземления: `action='applied'` открывает активную строку (`journal_id`, `site_id`, `point`, `grounding_type`, `tool_number`), `action='removed'` закрывает её (`removed_by/removed_at`, `version+1`). Повторная установка/снятие: запись журнала сохраняется, `sync/push` возвращает `status=conflict`, `conflicts[0].field='grounding_state'`, причина `grounding_already_applied` / `grounding_not_applied`; конфликт виден в `GET /v1/conflicts`. Изменение `event_type/event_data` существующего события заземления запрещено (`E-VAL-01`). Ответ реестра:

```json
{
  "id": "0193...", "journal_id": "0193...", "site_id": "0193...",
  "site_name": "Площадка А", "point": "КЛ-10 кВ, яч. 5",
  "grounding_type": "portable", "tool_number": "T-1", "count": 1,
  "state": "applied", "applied_by": "...", "applied_by_name": "Иванов И.И.",
  "applied_at": "2026-11-25T08:10:00.000Z", "removed_by": null,
  "removed_at": null, "version": 1
}
```

### 3.10. Структурированные переключения (757)

Событие `event_type='switching'` в `payload.event_data`:

```json
{
  "order_no": "БЛ-757/2026-14", "order_date": "2026-11-25",
  "responsible": "Петров П.П.",
  "operations": [
    { "operation": "open", "device": "Выключатель Q1",
      "from_state": "включено", "to_state": "отключено", "note": "по бланку" }
  ],
  "checks": [
    { "check": "Проверено отсутствие напряжения", "passed": true },
    { "check": "Ножи в крайнем положении", "passed": true, "note": "визуально" }
  ],
  "executed_at": "2026-11-25T07:50:00.000Z",
  "points": "РУ-10 кВ, яч. 5"
}
```

`operation`: `open` / `close` / `check` / `measure` / `other`; до 50 операций и 30 проверок. Старый свободный `sequence` (строка) принимается для обратной совместимости. Неизвестная операция, пустой бланк, отсутствие операций/последовательности/оборудования → `rejected / E-VAL-01`. Структурированные данные показываются в карточке записи и печатной 3-графной форме.

### 3.11. Retention, WORM-экспорт и backup-хуки (JRN-04/JRN-07)

| Метод | Путь | Роль | Назначение |
|---|---|---|---|
| `POST` | `/v1/journal/exports` | supervisor/admin/auditor | Сформировать WORM PDF (3 графы) + CSV за период/журнал |
| `GET` | `/v1/journal/exports/{id}` | supervisor/admin/auditor | Карточка экспорта: manifest, hash, signature_id, worm |
| `POST` | `/v1/exports/{id}/url` | supervisor/admin/auditor | Signed URL ≤900 с `{format: pdf\|csv}` |
| `GET` | `/v1/exports/{id}/download?token&format` | доступ | Скачать файл (сессия + подпись/срок/hash) |
| `GET` | `/v1/admin/exports?type&status&limit&offset` | admin | Список WORM-экспортов (aliases: `/v1/admin/exports/{id}`, `/url`, `/download`) |
| `GET` | `/v1/admin/retention?now` | admin/auditor | Политика 3 года, счётчики, runs, checkpoints, audit heads |
| `POST` | `/v1/admin/retention/run` | admin | Отчёт + проверка hash-цепочки аудита (audit `retention.check`) |
| `POST` | `/v1/admin/retention/archive` | admin | Архив записей старше cutoff → WORM export + manifest |
| `GET` | `/v1/admin/retention/archives` | admin/auditor | Архивные манифесты |
| `GET` | `/v1/admin/audit/verify` | admin/auditor | Проверка цепочки аудита: `{ok, streams_checked, events_checked, broken[]}` |
| `GET` | `/v1/admin/backup/manifest` | admin | Manifest для backup: счётчики таблиц, головы аудита, хэши экспортов |
| `POST` | `/v1/admin/backup/checkpoint` | admin | Зафиксировать checkpoint (`backup.checkpoint`) |

```json
POST /v1/journal/exports
{ "journal_id": "0193...", "from": "2026-11-01", "to": "2026-11-30" }
→ 201 {
  "id": "0193...", "status": "done", "type": "journal_pdf",
  "entries_count": 4, "file_sha256": "…64…", "file_size_bytes": 223553,
  "csv_sha256": "…64…", "manifest": { "files": {...}, "period": {...} },
  "manifest_hash": "…64…", "worm": true, "signature": { "id": "…" }
}
```

PDF содержит 3 графы (дата/№, содержание, визы/замечания), `journal_seq` и статус подписи по каждой записи; CSV — тот же набор, что `/journal/export`. Завершённый экспорт неизменяем (БД-триггер), удаление запрещено; скачивание — только по signed URL, TTL ≤ 900 с, привязка к id/формату/SHA-256. `POST /v1/admin/retention/archive` допускает только `to ≤ cutoff`; манифест архива также WORM. `RETENTION_YEARS` (по умолчанию 3) — единственный источник политики; OQ-05/OQ-18 не утверждены.

### 3.12. Администрирование пользователей и устройств (ADR-14, ADM-01/ADM-02)

| Метод | Путь | Роль | Назначение |
|---|---|---|---|
| `GET` | `/v1/admin/users?search&role&status&department_id&limit&offset` | admin | Каталог пользователей: `{items, total}`; `department_name` в строке |
| `POST` | `/v1/admin/users` | admin | Создать пользователя `{email, full_name, role, department_id, position?, external_id?}` → 201 |
| `PATCH` | `/v1/admin/users/{id}` | admin | `full_name`, `role`, `department_id`, `status`, `position`; аудит `user.update` |
| `POST` | `/v1/admin/users/{id}/revoke-sessions` | admin | Завершить все сессии пользователя; аудит `user.revoke_sessions` |
| `GET` | `/v1/admin/departments` | admin | Подразделения `{items: [{id, name, parent_id}]}` для форм |
| `GET` | `/v1/admin/devices?search&status&limit&offset` | admin | Все устройства: `{items, total}` с `user_name`/`user_email` |
| `DELETE` | `/v1/admin/devices/{id}` | admin | Отозвать устройство и привязанные сессии (владелец — `DELETE /v1/devices/{id}`) |

`GET /v1/me` дополнительно возвращает `csrf_token` (для отдельного admin origin, ADR-14): cookie `lb_csrf` API-домена недоступна JS на `admin.*`, поэтому токен приходит в профиле и хранится в памяти клиента. CORS разрешает два origin — `CORS_ORIGIN` и `ADMIN_ORIGIN` (production: оба https, admin ≠ основной origin). Cookies host-only и `SameSite=Lax`: у админ-домена собственная сессия.

### 3.4. Аудит и экспорт

`GET /v1/audit?actor_id&action&entity_type&entity_id&from&to&cursor&limit` — admin/supervisor.
`POST /v1/exports` `{ "type": "audit|entries|user_data", "params": {...} }` → `{ "job_id": "..." }`. Тип `audit` доступен в MVP; `entries` и `user_data` — v1.1. WORM PDF/CSV журнала — см. §3.11.
`GET /v1/exports/{id}` → `{ "status": "queued|running|done|failed", "file_url": "..." }`.

### 3.5. Служебные

`GET /v1/health` — liveness; `GET /v1/ready` — готовность (БД, очередь).

---

## 4. Синхронизация

### 4.1. `GET /v1/sync/changes`

| Параметр | Тип | Описание |
|---|---|---|
| `since_seq` | bigint | Курсор; `0` — с начала |
| `limit` | int | ≤ 200, по умолчанию 100 |

Область видимости по роли:

| Роль | Область `changes` |
|---|---|
| `worker` | Свои записи; наряды, где он участник; tombstones |
| `supervisor` | Свои записи + записи подразделения и подчинённых за 90 дней; наряды подразделения; tombstones |
| `admin` | Свои записи; наряды; массовая выгрузка записей запрещена |
| `auditor` (v1.1) | Только чтение в области, определённой администратором |

Справочники в `changes` не передаются — только `GET /v1/dictionaries/snapshot`.

Смены (`entity_type='shift'`) также попадают в `changes`: `supervisor` получает смены доступных журналов, `worker` — только свои сдачи/приёмки, `admin`/`auditor` — все. Сущность смены передаётся в `entity`, версия — в `version`.

Реестр заземлений (`entity_type='grounding'`) передаётся в `changes` по тем же правилам доступа к журналу; `entity` — строка `groundings` (см. §3.9).

```json
{
  "server_time": "2026-11-23T09:16:00.000Z",
  "next_seq": 10457,
  "has_more": true,
  "changes": [
    {
      "seq": 10450,
      "entity_type": "entry",
      "op": "upsert",
      "entity": {
        "id": "0193f0c4-...",
        "version": 4,
        "performed_at": "2026-11-23T06:40:00.000Z",
        "permit_binding_status": "linked",
        "sync_status": "synced"
      }
    },
    {
      "seq": 10451,
      "entity_type": "permit",
      "op": "upsert",
      "entity": { "id": "...", "status": "annulled", "version": 9 }
    },
    {
      "seq": 10452,
      "entity_type": "entry",
      "op": "delete",
      "entity_id": "0193f0c4-...",
      "deleted_at": "2026-11-23T09:00:00.000Z"
    }
  ]
}
```

**Правила:** `seq` монотонен; клиент сохраняет `next_seq` только после успешного применения страницы; `has_more` — продолжать; при `E-CURSOR-01` (курсор старше 90 дней) — полная пересинхронизация.

### 4.2. `POST /v1/sync/push`

**Запрос:**

```json
{
  "device_id": "0193f0c4-...",
  "app_version": "1.4.2",
  "ops": [
    {
      "op_id": "0193f0d0-...",
      "entity_type": "entry",
      "entity_id": "0193f0d1-...",
      "op_type": "create",
      "base_version": null,
      "hlc": "0001732344000123:00001:dev00001",
      "client_time": "2026-11-23T09:10:00.000Z",
      "payload": {
        "journal_id": "01930000-0000-7000-8000-000000001001",
        "performed_at": "2026-11-23T06:40:00.000Z",
        "performed_tz_offset_min": 180,
        "work_type_id": "...",
        "site_id": "...",
        "permit_id": "...",
        "text": "Заменён участок трубопровода на третьем стояке",
        "input_method": "voice",
        "asr_engine": "on_device",
        "asr_confidence": 0.87
      },
      "field_clocks": {
        "text": "0001732344000123:00001:dev00001",
        "permit_id": "0001732344000123:00001:dev00001"
      }
    }
  ]
}
```

**Ответ:**

```json
{
  "server_time": "2026-11-23T09:16:05.000Z",
  "results": [
    {
      "op_id": "0193f0d0-...",
      "status": "applied",
      "version": 1,
      "duplicate": false,
      "merged_entry": { "id": "0193f0d1-...", "version": 1, "created_at_server": "..." },
      "resolution": null,
      "error": null
    },
    {
      "op_id": "0193f0d2-...",
      "status": "conflict",
      "version": 4,
      "duplicate": false,
      "merged_entry": { "id": "...", "version": 4, "text": "Текст руководителя" },
      "resolution": { "text": "remote" },
      "conflicts": [
        { "field": "text", "reason": "verified_entry", "local_hlc": "...", "remote_hlc": "..." }
      ],
      "error": null
    }
  ],
  "next_seq": 10460
}
```

| `status` | Значение | Клиент |
|---|---|---|
| `applied` | Применено | Обновить сущность, удалить операцию |
| `duplicate` | Уже было применено | Обновить текущим состоянием, удалить операцию |
| `conflict` | Сервер выполнил merge | Применить `merged_entry`, создать `ConflictRecord` при `manual` |
| `rejected` | Не может быть применено | Операция в `dead`, показать ошибку |

Обязательные поля результата по статусам:

| `status` | Обязательные поля | Отсутствуют |
|---|---|---|
| `applied` | `merged_entry`, `version` | `error`, `conflicts` |
| `duplicate` | `merged_entry` (текущее состояние), `version` | `error`, `conflicts` |
| `conflict` | `merged_entry`, `conflicts[]`, `resolution` | `error` |
| `rejected` | `error` | `merged_entry`, `resolution` |

**Правила:**
- Батч ≤ 50 операций, ≤ 1 МБ, таймаут 30 с.
- Результаты возвращаются на каждую операцию; частичный успех допустим.
- `duplicate = true` — операция уже обрабатывалась; `merged_entry` содержит актуальное состояние.
- При `create` и `dead` для него зависимые `update`/`delete` тоже переводятся в `dead`.
- Конфликт не требует повторной отправки.
- `payload.journal_id` учитывается только при `create`: без поля запись создаётся в `main` (обратная совместимость старых клиентов). Нет доступа к журналу → `rejected / E-AUTH-02`. Для `update`/`delete` смена `journal_id` запрещена → `rejected / E-VAL-01`.
- `entity_type='shift'` (JRN-02): `create` — сдача смены (`journal_id`, `shift_date`, `period_start`, `period_end`, `handover_comment`), `update` — приёмка/отклонение (`action: accept|reject`, `comment?`, `rejection_reason?`) с обязательным `base_version`. Результат содержит `merged_shift`; конфликт версии/статуса возвращает `status=conflict` и актуальную смену, клиент помечает её как конфликт и показывает серверное решение.
- `event_type='switching'` валидируется по схеме из §3.10; `event_type='grounding'` дополнительно обновляет реестр (§3.9). Результат `grounding`-конфликта: `status=conflict`, `conflicts[0].field='grounding_state'`, `merged_entry` сохранён; запись не блокируется.
- `payload.event_type='grounding'` и `payload.event_data` существующей grounding-записи менять нельзя (`E-VAL-01`): новое состояние оформляется новой записью.
- Сервер назначает `journal_seq` внутри журнала; клиентское значение игнорируется. В `merged_entry` всегда возвращаются `journal_id` и `journal_seq`.

**Батчевая семантика (t17).** Весь `ops`-батч обрабатывается в одной транзакции с savepoint на операцию: `rejected`/`conflict` не откатывают остальные операции; идемпотентность `op_id` сохраняется (повтор → `duplicate=true`). `journal_seq` выдаётся блоками из per-journal sequence, поэтому номера уникальны и монотонны в журнале, но при полном откате батча возможны разрывы. Аудит пишется коалесцирующим writer-ом после commit (hash-chain сохраняется; `/v1/audit` и `/v1/admin/audit/verify` флашат очередь). Контракт ответа не меняется.

### 4.3. Порядок и приоритет

Клиент отправляет операции в порядке `hlc` внутри сущности. Сервер применяет последовательно в пределах сущности. Между сущностями порядок не гарантируется.

**Формирование батчей:** все операции одной сущности ДОЛЖНЫ попадать в один батч. Если операций по одной сущности больше 50, батчи отправляются последовательно с ожиданием ответа. Параллельные батчи (до 3) допускаются только для разных сущностей.

---

## 5. Онлайн-операции руководителя и администратора

| Метод | Путь | Роль | Назначение |
|---|---|---|---|
| `POST` | `/v1/entries/{id}/verify` | supervisor | Проверка записи |
| `POST` | `/v1/entries/{id}/unverify` | supervisor | Отмена проверки (с причиной) |
| `POST` | `/v1/entries/{id}/restore` | admin | Восстановление удалённой |
| `GET` | `/v1/conflicts` | supervisor/admin | Список конфликтов |
| `POST` | `/v1/conflicts/{id}/resolve` | supervisor/admin | Ручное разрешение |
| `POST` | `/v1/admin/users` | admin | Создание пользователя |
| `PATCH` | `/v1/admin/users/{id}` | admin | Роль, подразделение, статус |
| `POST` | `/v1/admin/users/{id}/revoke-sessions` | admin | Отзыв сессий |
| `POST` | `/v1/admin/permits/import` | admin | Импорт нарядов |
| `GET` | `/v1/admin/imports` | admin | Журнал импорта |
| `PATCH` | `/v1/admin/dictionaries/{name}` | admin | Изменение справочника |
| `POST` | `/v1/admin/journals` | admin | Создание журнала |
| `PATCH` | `/v1/admin/journals/{id}` | admin | Изменение/деактивация журнала |
| `PUT` | `/v1/admin/journals/{id}/members/{userId}` | admin | Доступ пользователя к журналу |
| `DELETE` | `/v1/admin/journals/{id}/members/{userId}` | admin | Отзыв доступа |

**Проверка записи:**

```json
POST /v1/entries/{id}/verify
{ "comment": "Проверено, замечаний нет" }
→ 200 { "id": "...", "version": 5, "verified_at": "...", "verified_by": "..." }
```

**Разрешение конфликта:**

```json
POST /v1/conflicts/{id}/resolve
{
  "resolution": "local",
  "values": { "text": "Текст, выбранный руководителем" },
  "comment": "Уточнено по факту"
}
→ 200 { "conflict_id": "...", "entry_version": 6 }
```

**Импорт нарядов:**

```json
POST /v1/admin/permits/import
{ "source": "csv", "file_id": "upl_...", "mode": "upsert" }
→ 202 { "job_id": "imp_...", "status": "queued" }
```

---

## 6. Лимиты и SLO

| Параметр | Значение |
|---|---|
| Запросов в минуту на пользователя | 100 |
| Размер тела запроса | 1 МБ (sync), 5 МБ (импорт) |
| Операций в батче | 50 |
| Одновременных синхронизаций на пользователя | 1 (по устройству — 1) |
| rate limit логина | 10 неуспешных / 15 мин |
| SLO push (p95) | ≤ 400 мс |
| SLO changes (p95) | ≤ 500 мс |
| SLO чтения (p95) | ≤ 300 мс |
| Доступность API | 99,5% в месяц |

---

## 7. Контрактные требования

1. OpenAPI 3.1 описывает все методы, схемы, коды ошибок и примеры; публикуется вместе с релизом.
2. Контрактные тесты на каждый метод обязательны в CI.
3. Изменение схемы ответа без мажорной версии запрещено, кроме добавления необязательных полей.
4. Все ответы содержат `server_time` и `request_id`.
5. Ошибки не раскрывают существование чужих объектов: `403` без деталей.
6. Тесты совместимости: текущая и предыдущая версии клиента против текущего сервера.

---

## Журнал изменений

| Версия | Дата | Изменения |
|---|---|---|
| 2.0 | 23.11.2026 | Контракт API редакции 2.0 |
| 2.1 | 23.11.2026 | Правки ревью: REV-004 (батчи одной сущности), REV-005 (область `changes` по ролям), REV-010 (экспорт аудита в MVP), REV-018 (обязательные поля по статусам), REV-019 (исключение `limit` для `changes`) |
