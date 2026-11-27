# Отчёт: PostgreSQL 15, backup/restore и нагрузка

| Параметр | Значение |
|---|---|
| Задача | t12 [postgres-production] |
| Статус | Инфраструктурная приёмка выполнена; **push-блокер закрыт в t17** (p95 279,6 мс при 20 VU, см. §6.7) |
| Дата | 25.11.2026 |
| Стенд | PostgreSQL 15.15 (Windows x64, портативные бинарники EDB), TLS 1.2+, `.data/pg15` |
| Миграции | 0001…0011 (включая `0007_auth_platform`, `0008_multi_journal`, `0009_shifts`, `0010_groundings`, `0011_permit_pdf`) |
| Связанные работы | QA-04, QA-06, ADM-06, ADM-07; OQ-02, OQ-04 |

---

## 1. Итог

| Проверка | Результат |
|---|---|
| Миграции 0001…0011 на PostgreSQL 15 | ✅ применены (11 файлов), повторный запуск — no pending |
| Seed | ✅ users=3, permits=3, entries=5 |
| TLS | ✅ `ssl=on`, TLS 1.2+; соединение без шифрования отклоняется `pg_hba`; API работает с `verify-full` по CA |
| Smoke API на PG 15 (20 проверок) | ✅ login/me, справочники, устройства, push 50 ops, виза с ЭП, подпись проверки, audit, `GET /shifts` (0009), `GET /groundings` (0010), CSV, logout |
| Backup (pg_dump -Fc) | ✅ 14,2 МБ, 5,3 с, SHA-256 + globals + манифест, retention 30 дней |
| Restore | ✅ 7,3 с; counts совпадают (48 714 записей, 5 015 пользователей, 28 775 audit), `journal_counters` без расхождений, hash-цепочка аудита цела |
| WAL-архив | ✅ `archive_mode=on`, 0 ошибок архивации, `archive_timeout=60s` |
| PITR-дрилл | ✅ восстановление на момент времени: маркер «до» есть, «после» отсутствует, promote, timeline 2 |
| HA-дрилл (streaming replica) | ✅ lag 0 байт, LSN совпадают, promotion **474 мс**, запись после promotion, timeline `00000002` |
| Нагрузка: чтения/`changes` | ✅ read p95 57–112 мс (≤300), changes p95 114–208 мс (≤500), 0 ошибок |
| Нагрузка: push 50 ops | ❌ (t12) p95 5 307 мс при 20 VU и 911 мс при 1 VU (порог 400 мс) — **закрыто в t17: 279,6 мс, §6.7** |
| `npm run typecheck` / `npm test` / `npm run build` | ✅ 0 / 211 passed (shared 28, API 74, web 109) / 0 |

Найденные и исправленные по ходу приёмки дефекты (PostgreSQL-специфичные, PGlite их маскировал):
см. §4. Нагрузочный дефект push требует изменения sync-слоя (backend), зафиксирован как блокер релиза.

---

## 2. Стенд и как воспроизвести

Docker в окружении отсутствует, поэтому поднят портативный PostgreSQL 15.15
(официальные бинарники EDB) с теми же параметрами, что в `docker-compose.yml`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pg/bootstrap-pg15.ps1
# initdb UTF8/SCRAM, self-signed TLS, hostssl-only pg_hba, WAL archive, port 55432
```

Параметры кластера: `ssl=on`, `ssl_min_protocol_version=TLSv1.2`,
`password_encryption=scram-sha-256`, `shared_buffers=256MB`, `max_connections=100`,
`wal_level=replica`, `archive_mode=on`, `archive_timeout=60s`,
`log_min_duration_statement=250`, `log_checkpoints=on`, `log_lock_waits=on`.

Применение схемы и seed (TLS `verify-full`):

```bash
DATABASE_URL=postgres://logbook:logbook@127.0.0.1:55432/logbook \
DATABASE_SSL_MODE=verify-full \
DATABASE_SSL_CA_PATH=.data/pg15/certs/server.crt \
npm run db:migrate
# Migrations applied: 0001_init.sql … 0009_shifts.sql, 0010_groundings.sql
DATABASE_URL=... npm run db:seed
# Seed complete: users=3, permits=3, entries=5
```

Проверка TLS:

```bash
psql "host=127.0.0.1 port=55432 user=logbook dbname=logbook sslmode=disable"
# FATAL: pg_hba.conf rejects connection ... no encryption
psql "host=127.0.0.1 port=55432 user=logbook dbname=logbook sslmode=verify-full sslrootcert=.data/pg15/certs/server.crt"
# PostgreSQL 15.15 | ssl=on | TLSv1.2
```

Docker-конфигурация (primary + streaming replica, TLS, WAL-архив, healthcheck) —
`docker-compose.yml`; эксплуатация — `db/postgres/README.md`. В этом окружении
compose не запускался (нет Docker); эквивалентная конфигурация проверена на
портативном кластере.

---

## 3. Backup / restore (ADM-06)

Артефакты:

- `scripts/pg/backup.ps1` — `pg_dump -Fc -Z6` + `pg_dumpall --globals-only`,
  SHA-256, JSON-манифест, retention 30 дней;
- `scripts/pg/restore.ps1` — восстановление в целевую БД, `ANALYZE`, проверка
  counts, числа миграций и согласованности `journal_counters`;
- `scripts/pg/pitr-drill.ps1` — base backup + WAL + `recovery_target_time`;
- `scripts/pg/restore-wal.cmd` — restore_command для Windows (PG удаляет
  backslash из конфигурации, cmd copy требует backslash).

Фактические замеры (датасет 5 015 пользователей / 48 714 записей / 182 МБ):

| Операция | Результат |
|---|---|
| `pg_dump -Fc -Z6` | 14 193 897 байт, 5 334 мс, sha256 `c1ebdae1…` |
| `pg_restore -j4` | 7 267 мс |
| counts после restore | users 5015, entries 48714, audit 28775, signatures 8, journals 2, reviews 4, migrations 11, shifts 0, groundings 0 |
| `journal_counters` mismatch | 0 |
| hash-цепочка audit после restore | 0 разрывов, 0 «плохих» genesis на 28 775 событиях |

### 3.1. 0009_shifts, 0010_groundings и 0011_permit_pdf на PostgreSQL 15

Все миграции применены к кластеру с данными (0001–0010 → 0011 без пересоздания БД):

| Проверка | Результат |
|---|---|
| `schema_migrations` | `0009_shifts.sql`, `0010_groundings.sql`, `0011_permit_pdf.sql` (всего 11) |
| `GET /v1/shifts` | 200, `items=[]` |
| `GET /v1/groundings` | 200, `items=[]` |
| `groundings` колонки | 17, включая `journal_id NOT NULL`, `state/grounding_type` enum, `count CHECK 1..100`, `version` |
| FK `groundings` | 6: `journal_id→journals`, `site_id→sites`, `applied_entry_id/removed_entry_id→journal_entries`, `applied_by/removed_by→users` |
| Индексы `groundings` | PK, partial unique `groundings_active_uq` (journal/site/point/type/tool WHERE state='applied'), `journal`, `site`, `point` |
| `0011` в PG 15 | `permits.pdf_generated_at`, `permits.pdf_source` (CHECK generated/external/none), partial index `permits_pdf_idx` |
| `0011` после restore | обе колонки присутствуют в восстановленной БД |
| Восстановление из дампа | `groundings=0`, `shifts=0`, `migrations=11`, counters 0 mismatch, audit-цепочка цела |

PITR (drill, JSON-результат скрипта):

```json
{
  "target_time": "2026-11-25 01:28:56.264029+00",
  "marker_before_present": true,
  "marker_after_present": false,
  "promoted": true,
  "timeline_id": "2"
}
```

RPO/RTO: WAL-архив каждые ≤60 с (`archive_timeout`), логическое восстановление
минуты (5,8 с на 40 тыс. записей), целевые RPO ≤24 ч и RTO ≤4 ч выполняются с
большим запасом. Ежедневный бэкап + ежеквартальный restore-дрилл — регламент
`db/postgres/README.md`.

---

## 4. Найденные и исправленные дефекты

### 4.1. Неверная сортировка sequence аудита (критично, PG и PGlite)

`AuditService` читал последний `stream_seq` запросом
`select stream_seq::text as stream_seq ... order by stream_seq desc`: ORDER BY
ссылался на текстовый алиас, поэтому «9» > «10». После 9 событий в потоке за
день каждый следующий insert падал на `audit_stream_unique` (на PostgreSQL — 500).
Исправлено: `order by audit_events.stream_seq desc`.

### 4.2. Гонка при конкурентной записи аудита

Read-last + insert не защищён между соединениями; при параллельных запросах два
писателя получали одинаковый `stream_seq`. Добавлен transaction-scoped advisory
lock на поток (`pg_advisory_xact_lock(hashtext(stream))`) в `SqlClient`
(`advisoryXactLock`, реализован в `PgSqlClient`, no-op для PGlite) и обёртка
`AuditService.record` в (вложенную) транзакцию. Это не влияет на PGlite-тесты и
сохраняет атомарность аудита с бизнес-изменением.

### 4.3. TLS/пул для PostgreSQL в конфигурации API

`env.ts`: `DATABASE_SSL_MODE` (`disable`/`require`/`verify-full`),
`DATABASE_SSL_CA_PATH`, `DATABASE_POOL_MAX`; production-гейт требует TLS для
внешней БД и CA для `verify-full`. `PgSqlClient`/`client-factory` передают
`ssl` и размер пула. Проверено `verify-full` на PG 15.

Все три изменения покрыты регрессией: `npm test` — 211 passed, typecheck/build
зелёные. API-тесты на PGlite не ловили 4.1, потому что в тестовых потоках было
меньше 10 событий; production-приёмка на PG 15 выявила дефект.

---

## 5. HA / failover

`scripts/pg/replica-drill.ps1`:

```json
{
  "basebackup_ms": 6020,
  "standby_streaming": true,
  "lag_bytes_before_promote": 0,
  "primary_lsn": "0/21001340",
  "replica_lsn": "0/21001340",
  "data_loss_rows": 0,
  "promote_ms": 474,
  "new_timeline": "00000002",
  "write_after_promote": "0/210013C0"
}
```

Реплика потоковая (`pg_basebackup -X stream -R`), lag 0, promotion 474 мс,
после promotion запись разрешена, таймлайн 2. Автоматический failover
(Patroni/облачный сервис) не настраивался — это инфраструктурное решение
заказчика; ручной runbook — `db/postgres/README.md`.

---

## 6. Нагрузка (QA-06) и причина провала push

Скрипт `scripts/pg/loadtest.mjs`, данные `scripts/pg/scale-fixture.mjs`
(5 000 пользователей, 5 000 устройств, 20 000 записей; фактически 40 964 записи
после предыдущих прогонов).

### 6.1. Смешанный профиль, 20 VU, 60 с

| Сценарий | Кол-во | p50 | p95 | p99 | max | Порог |
|---|---|---|---|---|---|---|
| read `/entries?limit=50` | 479 | 40,6 | **57,5** | 91,4 | 183 | ≤300 ✅ |
| changes `limit=200` | 133 | 83,8 | **114,1** | 122,7 | 237 | ≤500 ✅ |
| push 50 ops | 297 | 3 861,5 | **5 306,7** | 5 664,4 | 6 084,8 | ≤400 ❌ |
| snapshot | 43 | 139,0 | 200,1 | 205,9 | 205,9 | — |

RPS 15,1; 0 ошибок (2xx 952/952). Общий RPS ограничен push.

Повторный прогон после 0010 (30 с, 20 VU): read p95 64,2 мс, changes p95 187,1 мс,
push p95 **5 106,7** мс, snapshot p95 213,8; 500/500 без ошибок — картина та же.

### 6.2. Один клиент, 30 с

push p50 351,6 мс, p95 **910,8** мс, p99 931,3; read p95 13,7; changes p95 39,4.
То есть даже без конкуренции 50 операций не укладываются в 400 мс.

### 6.3. `synchronous_commit=off` (диагностика)

push p50 276,2 мс, p95 **866,5** мс — fsync не является основной причиной
(после замера параметр возвращён в `on`).

### 6.4. Read-heavy при 5 000 пользователей / 40 964 записях, 20 VU, 60 с

165,2 RPS, 9 925 запросов, 0 ошибок; read p95 **112,3** мс,
changes p95 **207,9** мс, snapshot p95 334,8 мс — пороги чтений пройдены.
JSON-результаты: `.data/pg15/results/load-*.json`.

### 6.5. Root cause

- `SyncService.push` выполняет **транзакцию на каждую операцию** (50 коммитов
  на push), а нумерация `journal_seq` в 0008 идёт через `UPSERT` в
  `journal_counters` — одна строка на журнал. Все записи журнала сериализуются
  на этой строке; под конкуренцией insert в `journal_entries` занимает
  250–350 мс (подтверждено `log_min_duration_statement`), при 1 VU — ~5,5 мс/оп.
- Аудит с hash-цепочкой добавляет последовательную запись на каждую операцию
  (advisory lock на поток) и ещё один commit WAL.
- Итог: пропускная способность push ≈ 200–250 операций/с на журнал,
  латентность растёт линейно с очередью.

### 6.6. Требуемое исправление (backend, sync/merge)

1. Обрабатывать push-батч (≤50 ops) **в одной транзакции** с savepoint на
   операцию для изоляции `rejected`/`conflict`; один commit вместо 50.
2. Аудит батча: одна запись на пачку либо асинхронный audit-writer с групповым
   commit (сохраняя hash-цепочку).
3. `journal_counters`: резервировать блок последовательностей на транзакцию
   (`UPDATE … last_seq = last_seq + N RETURNING`), а не строку на каждую запись.
4. Повторить `loadtest.mjs` (push 50 ops p95 ≤400 мс, 50 rps) после изменений.

До исправления push-порог QA-06 считается **невыполненным**; чтения и changes —
выполнены.

---

### 6.7. Закрытие блокера (t17, 25.11.2026)

Синхронизация переделана: одна транзакция на push-батч + savepoint на операцию,
per-journal sequence вместо блокировки `journal_counters` (миграции 0013/0014),
bulk INSERT записей/change_log/idempotency, коалесцирующий audit-writer.
Повторный прогон на PostgreSQL 15.15 (схема 0001–0014, 20 VU × 50 ops, 30 с):

```
push 2207, p50 211,7 / p95 279,6 / p99 2207,4 / max 2811,9 мс
0 ошибок, 73,1 rps, All QA-06 thresholds passed
```

Порог push 50 ops ≤400 мс выполнен (было 5 306,7 мс). Смешанный профиль: push p95
372,1 мс ✅; read/changes под высокой push-нагрузкой требуют отдельной оптимизации
(см. `37_Отчёт_Push_Loadtest.md`). 0012 (retention/WORM) на горячий путь push не
влияет: её триггеры — DELETE journal_entries и WORM export_jobs/archive_manifests.
Статус инфраструктурной приёмки: блокер sync-слоя снят.

## 7. Артефакты

| Файл | Назначение |
|---|---|
| `scripts/pg/bootstrap-pg15.ps1` | скачивание/initdb/TLS/hostssl/WAL/старт PG 15 |
| `scripts/pg/make-cert.mjs` | self-signed TLS (openssl или `selfsigned`) |
| `scripts/pg/backup.ps1`, `restore.ps1` | бэкап/восстановление + проверки |
| `scripts/pg/pitr-drill.ps1`, `restore-wal.cmd` | PITR-дрилл и restore_command |
| `scripts/pg/replica-drill.ps1` | streaming replica + failover-дрилл |
| `scripts/pg/smoke.mjs` | 19 проверок API на PG 15 |
| `scripts/pg/loadtest.mjs` | нагрузка с p50/p95/p99 и порогами QA-06 |
| `scripts/pg/scale-fixture.mjs` | 5 000 пользователей / 20 000 записей |
| `docker-compose.yml` | PG 15 primary + replica (`--profile ha`), TLS, WAL-архив |
| `db/postgres/README.md`, `db/postgres/init/01-replication.sql` | эксплуатация TLS/HA/backup |
| `.env.example` | `DATABASE_SSL_MODE`, `DATABASE_SSL_CA_PATH`, `DATABASE_POOL_MAX` |
| `apps/api/src/{db/pg-client,db/client-factory,db/sql-client,audit/audit.service,config/env}.ts` | TLS/пул + исправления аудита |

---

## 8. Ограничения и риски

1. **Docker недоступен** — compose-конфигурация не исполнялась; приёмка выполнена
   на эквивалентном PostgreSQL 15.15 (Windows). Для приёмки «как в production»
   повторить на Docker/Linux (t15) — скрипты переносимы, кроме PowerShell-обвязки.
2. **Push p95 не пройден** (см. §6) — блокер выпуска до исправления sync-слоя.
3. **Автоматический failover** не настроен; ручной promotion проверен.
4. **TLS-сертификат** лаборатории самоподписанный; production — корпоративный CA.
5. **Upgrade-дрилл «0005 → 0006 с данными»** (QA-04) отдельно не выполнялся;
   проверена аддитивность 0007–0011 на заполненной БД (миграции применены к
   базе с 40 тыс. записей после 0001–0010, затем 0011).
6. Нагрузочные цифры получены на одном узле (CPU/диск рабочей станции), не на
   выделенном стенде; абсолютные значения не переносятся на production без
   повторного замера.
7. `pg_stat_statements` не включён; диагностика по `log_min_duration_statement`.

---

## 9. Что дальше

1. Backend: batch-транзакция push + блочная выдача `journal_seq` + батчевый
   аудит; повторить нагрузку до p95 ≤400 мс.
2. QA/t15: приёмочный прогон на PostgreSQL 15 в Docker/Linux по этим же скриптам.
3. ADM-07: reverse proxy/TLS termination, HSTS, секреты в secret manager,
   автоматический failover (Patroni/облако), мониторинг и алерты.
4. ADM-06: регламент ежедневных бэкапов и ежеквартального restore-дрилла на
   production-данных; проверить retention 30 дней и off-site копию.
