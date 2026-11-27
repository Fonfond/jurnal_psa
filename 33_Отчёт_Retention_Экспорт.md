# Отчёт 33. Retention, архив и WORM-экспорт (JRN-04/JRN-07/ADM-04, t7)

| Параметр | Значение |
|---|---|
| Дата | 25.11.2026 (обновлено 27.11.2026, t24) |
| Задача | t7 [retention-pdf]; t24 [REP-05] — scheduler/TTL/alerts |
| Статус | Выполнено; сроки хранения и ЭП требуют утверждения (OQ-05/OQ-18/OQ-04) |
| Миграции | `0012_retention_export.sql`, `0017_retention_scheduler.sql` |
| Проверка | `npm test` — 28 shared / 125 API / 153 web = **306 pass**; typecheck 0; build ok |

## 1. Retention и аудит

Политика — `RETENTION_YEARS` (по умолчанию 3). `GET /v1/admin/retention` отдаёт
политику/cutoff, счётчики записей, `runs[]`, `checkpoints[]`, головы аудита.
`POST /v1/admin/retention/run` формирует отчёт, пересчитывает hash-цепочку всех
потоков аудита, пишет `retention_runs` и аудит `retention.check`; поддерживает
`now` для ускоренного времени. `GET /v1/admin/audit/verify` — отдельная проверка
цепочки (`{ok, streams_checked, events_checked, broken[]}`), tamper hash
обнаруживается.

Физическое удаление записи журнала моложе 3 лет блокирует триггер
`journal_entries_retention_guard`; мягкое удаление разрешено. Старые записи могут
быть архивированы и физически удалены после срока.

### 1.1. Ежедневный scheduler, TTL и алерты (t24 / REP-05)

- `RetentionSchedulerService` запускает job ежедневно в `RETENTION_SCHEDULE_UTC`
  (по умолчанию `02:00`), отключён при `RETENTION_SCHEDULER_ENABLED=false` и в
  `NODE_ENV=test`. Внешний cron/systemd timer может заменить in-process планировщик.
- Идемпотентность: уникальный partial index по `(run_date)` для
  `trigger='scheduler'`; повторный запуск в тот же UTC-день возвращает
  `{skipped:true, reason:'already_ran_today'}`, failed-run можно повторить.
- Каждый run пишет `retention_runs` (`trigger`, `status`, `run_date`,
  `duration_ms`, `error`), проверяет hash-цепочку аудита и TTL:
  - `change_log` старше `CHANGE_LOG_RETENTION_DAYS` (90, ADR-07) удаляется;
    `GET /sync/changes` с устаревшим курсором отдаёт `E-CURSOR-01` (410);
  - просроченные **не-WORM** `export_jobs` (`expires_at`, `EXPORT_JOB_RETENTION_DAYS=7`)
    удаляются; WORM-экспорты и архивные манифесты не удаляются никогда;
  - записи журнала не удаляются: 3-летний DB-guard и архив сохраняют их.
- Алерты (`retention_alerts` + Nest log + optional webhook):
  `run_failed` (ошибка запуска/нет admin-актора), `audit_broken` (повреждение
  цепочки), `run_overdue` (последний успешный run старше `RETENTION_OVERDUE_HOURS=26`).
  Неудачная доставка webhook не откатывает run, ошибка сохраняется в `delivery_error`.
- API: `GET /v1/admin/retention` (scheduler state, ttl, alerts, runs),
  `GET /v1/admin/retention/alerts`, `POST /v1/admin/retention/scheduler/run`
  (admin; `now` для ускоренного времени).

## 2. WORM-экспорт PDF/CSV

`POST /v1/journal/exports` (supervisor/admin/auditor) формирует серверный PDF
3-графной формы (дата/№, содержание, визы/замечания), включая `journal_seq` и
статус подписи каждой записи, и CSV (тот же набор, что `/journal/export`). Оба
файла сохраняются в `export_jobs` (`file_bytes`/`csv_bytes`), manifest содержит
SHA-256 и размеры, `manifest_hash`; PDF подписывается ЭП-адаптером
(`document_signatures.entity_type='export'`, content hash = SHA-256 PDF),
подпись проверяется `/signature/:id/verify`. Завершённый экспорт неизменяем и не
удаляется (WORM-триггеры), `download_count` инкрементируется.

Скачивание — по signed URL: `POST /v1/exports/{id}/url` (TTL ≤900 с, HMAC
`EXPORT_SIGNING_SECRET`/`COOKIE_SECRET`, привязка к id/format/SHA-256) и
`GET /v1/exports/{id}/download?token&format`; события `journal.export.pdf`,
`export.url`, `export.download` в аудите. Admin-алиасы: `/v1/admin/exports*`.

## 3. Архив и backup-хуки

`POST /v1/admin/retention/archive` (`to ≤ cutoff`) создаёт WORM-экспорт и
неизменяемый `archive_manifests`; `GET /v1/admin/retention/archives` — список.
Восстановление — скачивание архивного PDF по signed URL (данные не удаляются
автоматически).

Backup-хуки: `GET /v1/admin/backup/manifest` (счётчики таблиц, головы аудита,
хэши экспортов, retention) и `POST /v1/admin/backup/checkpoint` (аудит
`backup.checkpoint`); вызываются перед `scripts/pg/backup.ps1`, manifest
проверяется после restore. WORM-экспорты входят в backup (bytea в `export_jobs`).

## 4. Проверки

- `apps/api/test/retention-export.spec.ts` (6): политика/run/аудит и broken-chain;
  hard-delete old/recent; генерация PDF/CSV, manifest/hash, ЭП+verify, signed URL,
  tamper/expired/чужой/401, WORM UPDATE/DELETE; admin exports/checkpoint; архив и
  WORM манифеста.
- `apps/api/test/retention-scheduler.spec.ts` (6): расчёт UTC-расписания,
  идемпотентность scheduler-run (1 строка/день), TTL change_log/export_jobs с
  сохранением свежих записей и WORM, `E-CURSOR-01` для устаревшего курсора,
  alert audit_broken, отсутствие admin-актора → skipped + critical alert.
- `apps/api/test/retention-alerts.spec.ts` (2): доставка webhook и сохранение
  алерта при HTTP 503 (`delivery_error`).
- `apps/api/test/db.spec.ts`: миграции 0001–0017, таблицы retention/alerts/архива.
- Web-тесты и API-регрессии — зелёные; typecheck (app+SW) и build успешны.

## 5. Ограничения

- Юридические сроки 3 года и значимость PDF/ЭП не утверждены (OQ-05/OQ-18/OQ-04):
  реализована заявленная политика, scheduler её не меняет.
- In-process scheduler работает в одном инстансе; при нескольких репликах нужен
  внешний cron/systemd timer (идемпотентность в БД защищает от дублей, но каждая
  реплика будет пытаться запустить job).
- WORM-файлы намеренно не удаляются по TTL (ADM-04); TTL применяется только к
  не-WORM `export_jobs` и `change_log`. `change_log` TTL 90 дней: клиенты с более
  старым курсором получают `E-CURSOR-01` и делают полную пересинхронизацию.
- Алерты доставляются в логи/БД и optional webhook; email/SMS-каналы не реализованы
  (внешняя интеграция — зона эксплуатации).
- Планировщик выключен в тестах; production должен явно включить
  `RETENTION_SCHEDULER_ENABLED=true` или иметь внешний timer + `false`.
