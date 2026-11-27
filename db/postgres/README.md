# PostgreSQL 15 в production: TLS, backup/restore, HA, нагрузка

Раздел описывает production-конфигурацию PostgreSQL 15 для Logbook и результаты
приёмки на локальном кластере (см. `29_Отчёт_PostgreSQL_Production.md`).

## 1. TLS

PostgreSQL должен принимать только `hostssl`-соединения:

```conf
ssl = on
ssl_cert_file = '/certs/server.crt'
ssl_key_file  = '/certs/server.key'
ssl_min_protocol_version = 'TLSv1.2'
```

`pg_hba.conf` (порядок важен, сначала `hostssl`/`hostnossl reject`):

```
hostssl all all 0.0.0.0/0 scram-sha-256
hostssl replication replicator 0.0.0.0/0 scram-sha-256
hostnossl all all 0.0.0.0/0 reject
```

Клиент (API):

```env
DATABASE_URL=postgres://logbook:***@db.internal:5432/logbook
DATABASE_SSL_MODE=verify-full
DATABASE_SSL_CA_PATH=/etc/logbook/db-ca.pem
DATABASE_POOL_MAX=10
```

`verify-full` проверяет цепочку и hostname; `require` шифрует без проверки CA
(допустимо только в локальной лаборатории). Production-гейт `env.ts` не даёт
запустить API с внешней БД без TLS.

Сертификат: корпоративный CA. Для лаборатории:

```bash
npm install --no-save selfsigned
node scripts/pg/make-cert.mjs db/postgres/certs
# или: openssl req -new -x509 -days 825 -nodes -out db/postgres/certs/server.crt \
#       -keyout db/postgres/certs/server.key -subj '/CN=logbook-db' \
#       -addext 'subjectAltName=DNS:logbook-db'
```

`db/postgres/certs/` исключён из репозитория.

## 2. Запуск (Docker Compose)

```bash
node scripts/pg/make-cert.mjs db/postgres/certs     # один раз
docker compose up -d                                 # primary :5432
docker compose --profile ha up -d                    # + streaming replica :5433
docker compose logs -f postgres
```

Миграции и seed (с хоста, TLS):

```bash
DATABASE_URL=postgres://logbook:logbook@127.0.0.1:5432/logbook \
DATABASE_SSL_MODE=verify-full \
DATABASE_SSL_CA_PATH=db/postgres/certs/server.crt \
npm run db:migrate
```

`docker-compose.yml` — конфигурация для сред с Docker; в текущем окружении Docker
отсутствует, поэтому приёмка выполнена на портативном PostgreSQL 15.15
(`scripts/pg/bootstrap-pg15.ps1`) с теми же параметрами TLS/WAL.

## 3. Backup/restore (ADM-06)

Ежедневный логический бэкап + WAL-архив для PITR:

```powershell
# Windows lab
.\scripts\pg\backup.ps1 -KeepDays 30
# Linux/production (пример)
pg_dump -Fc -Z6 -f /backups/logbook-$(date +%F).dump "$DATABASE_URL"
pg_dumpall --globals-only -f /backups/globals-$(date +%F).sql
```

Скрипт `backup.ps1`:

- `pg_dump -Fc -Z6` + `pg_dumpall --globals-only`;
- SHA-256 на каждый файл и JSON-манифест (БД, размер, длительность, sslmode);
- retention 30 дней (ADM-06);
- восстановление: `restore.ps1 -Dump <file> -TargetDatabase logbook_restore`
  (проверяет counts, число миграций, согласованность `journal_counters`).

Проверено на PostgreSQL 15.15: дамп 10,7 МБ / 40 914 записей — 3,2 с;
восстановление — 6,1 с; журнальные счётчики и hash-цепочка аудита совпадают.

WAL и PITR:

```conf
archive_mode = on
archive_command = 'test ! -f /archive/%f && cp %p /archive/%f'
archive_timeout = '60s'
```

Дрилл: `scripts/pg/pitr-drill.ps1` (base backup + WAL + `recovery_target_time`);
проверено: точка восстановления достигнута, запись после target отсутствует,
таймлайн повышен.

RPO/RTO (лаборатория): WAL-архив ≤ 60 с (`archive_timeout`), RPO ≤ 1 мин при
непрерывном архиве; RTO логического восстановления — минуты (6 с на 40 тыс.
записей), целевой RTO ≤ 4 ч выполняется с запасом.

## 4. HA и failover

`docker compose --profile ha up -d` поднимает физическую реплику
(`pg_basebackup -X stream -R`). Проверка:

```sql
-- primary
select client_addr, state, sync_state, pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) as lag_bytes
  from pg_stat_replication;
-- replica
select pg_is_in_recovery(), pg_last_wal_replay_lsn();
```

Promotion:

```bash
docker exec logbook-postgres-replica pg_ctl promote -D /var/lib/postgresql/data
# затем переключить DATABASE_URL на реплику и перезапустить API
```

Дрилл `scripts/pg/replica-drill.ps1` (лаборатория): потоковая репликация,
lag 0 байт, promotion 474 мс, запись после promotion разрешена, таймлайн 2.
В production — управляемый failover (Patroni/repmgr или облачный сервис);
ручной promotion допустим только по runbook.

## 5. Нагрузка и тюнинг

```bash
BASE_URL=http://127.0.0.1:3101/v1 DURATION_MS=60000 CONCURRENCY=20 \
  MIX=read:50,changes:15,push:30,snapshot:5 node scripts/pg/loadtest.mjs
node scripts/pg/scale-fixture.mjs     # 5 000 пользователей / 20 000 записей
```

Результаты и ограничения — в отчёте 29. Кратко: чтения и `changes` проходят
пороги QA-06, `push 50 ops` под конкуренцией не проходит из-за транзакции на
операцию и строкового счётчика `journal_counters` (требуется batch-запись в
sync-слое). Для диагностики включены `log_min_duration_statement=250`,
`log_checkpoints`, `log_lock_waits`.

Параметры для production (ориентир):

```
shared_buffers = 25% RAM
effective_cache_size = 60% RAM
max_connections = 200
work_mem = 8MB
maintenance_work_mem = 256MB
wal_compression = on
checkpoint_completion_target = 0.9
max_wal_size = 4GB
```

## 6. Мониторинг

- `pg_stat_activity` (долгие транзакции), `pg_stat_replication.lag`,
  `pg_stat_archiver.failed_count`.
- Ошибки `audit_stream_unique` (признак обхода advisory-lock),
  `journal_counters` lock waits (`log_lock_waits`).
- Размер БД/таблиц, bloat, autovacuum; алерты на `failed_count > 0`,
  lag > 30 с, RTO-дрилл ежеквартально.

## 7. Ограничения

- Docker в текущем окружении недоступен: compose-конфигурация не запускалась,
  проверена эквивалентная конфигурация на PostgreSQL 15.15.
- TLS-сертификат лаборатории самоподписанный; production — корпоративный CA.
- Автоматический failover не настраивался (нужен Patroni/облако).
- Нагрузочный дефект push (`journal_counters` + per-op commit) — зона backend
  (sync/merge), вне инфраструктурной задачи t12; зафиксирован в отчёте 29.
