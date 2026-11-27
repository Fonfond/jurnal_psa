# t30 / F-01, F-02, F-04: cold install, ANALYZE, rate-limit loadtest

| Параметр | Значение |
|---|---|
| Дата | 27.11.2026 |
| Задача | t30 (F-01/F-02/F-04 из t28) |
| Стенд | PostgreSQL 15.15 (портативный кластер `.data/pg15`, порт 55432, TLS), Windows, один инстанс API, pool 28 |
| Нагрузка | `scripts/pg/loadtest.mjs`, 20 VU, 60 с, ramp 3 с, `MIX=read:50,changes:15,push:30,snapshot:5`, 50 ops/push |
| Порог QA-06 | read ≤ 300 мс, changes ≤ 500 мс, push ≤ 400 мс, errors < 0.1 % |
| Итог | cold без ANALYZE — **FAIL** (finding F-01); после ANALYZE — **PASS**; production-limit режим даёт 99.18 % 429 (ожидаемо) |

> **t32 residual:** `db:seed`/fixture ANALYZE недостаточны, если после них идёт
> bulk/scale/load. Перед измерением обязателен ANALYZE после fixture/import и
> после прогрева нагрузки (`WARMUP_MS` в loadtest). Актуальная процедура и
> доказательства — [docs/loadtest/t32/README.md](t32/README.md).

## 1. Точные шаги cold-install

```powershell
# 1. Свежая БД (PG 15, TLS-only)
createdb -h 127.0.0.1 -p 55432 -U logbook logbook_t30_fresh

$env:DATABASE_URL='postgresql://logbook:logbook@127.0.0.1:55432/logbook_t30_fresh'
$env:DATABASE_SSL_MODE='require'
$env:NODE_ENV='development'

# 2. Миграции 0001–0017
npm run db:migrate

# 3. Seed без ANALYZE — только для воспроизведения cold-дефекта (t30 evidence).
#    В обычной установке seed уже завершается ANALYZE (F-01), см. §3.
#    .data/t30-seed-cold.ts вызывает seedDatabase() и НЕ делает ANALYZE.
npx tsx .data/t30-seed-cold.ts
# COLD_SEED users=3 entries=5

# 4. Проверить отсутствие статистики (до нагрузки):
#    pg_stat_user_tables.last_analyze = never, pg_statistic = 0 для change_log

# 5. API в loadtest-режиме (rate limit явно обойдён; production это запрещает)
$env:PORT='3110'
$env:DATABASE_POOL_MAX='28'
$env:RUN_MIGRATIONS_ON_START='false'
$env:RATE_LIMIT_ENABLED='true'
$env:LOADTEST_RATE_LIMIT_DISABLED='true'
$env:RETENTION_SCHEDULER_ENABLED='false'
node apps/api/dist/main.js

# 6. Нагрузка
$env:BASE_URL='http://127.0.0.1:3110/v1'
$env:DURATION_MS='60000'; $env:CONCURRENCY='20'; $env:RAMP_MS='3000'
$env:MIX='read:50,changes:15,push:30,snapshot:5'
node scripts/pg/loadtest.mjs
```

## 2. Результаты cold (без ANALYZE)

`cold-no-analyze.log` / `cold-no-analyze.json`:

```
scenario   count    p50     p95     p99     max
read         2612   121.5   247.8  287.0   467.6
changes       786   329.2   612.1  727.7   813.8
push         1589   298.4   419.1 2196.8  3481.2
snapshot      277   130.6   192.6  224.7   299.9
requests=5264 rps=87.5 2xx=5264 4xx=0 5xx=0 error_rate=0.000%
THRESHOLD FAILURES: changes p95 612.1ms > 500ms; push p95 419.1ms > 400ms
```

До запуска: `last_analyze=never` для `change_log`/`journal_entries`,
`pg_statistic=0` для `change_log`. В ходе прогона PostgreSQL успел выполнить
autoanalyze (`change_log` 10:21:08), но ранняя часть нагрузки шла без статистики;
результат — **fail changes/push**. Это воспроизводит t28 (837.7/421.8) и
подтверждает F-01: cold fresh PG без ANALYZE не проходит пороги.

## 3. ANALYZE обязателен (F-01)

Код/команды:

- `npm run db:seed` — после seed выполняет `ANALYZE` (seed-cli).
- `npm run db:analyze` — отдельный обязательный шаг после migrate/bootstrap,
  если seed не запускался.
- `ANALYZE` вызывает `apps/api/src/db/analyze-cli.ts`.

Повторный прогон на той же БД после `ANALYZE`:

`after-analyze.log` / `after-analyze.json`:

```
scenario   count    p50     p95     p99     max
read         4127    47.8    71.8    87.9   369.8
changes      1219   105.5   139.2   169.2   313.7
push         2366   279.3   350.1  2558.3  2805.4
snapshot      428   131.0   168.4   190.8   415.5
requests=8140 rps=135.0 2xx=8140 4xx=0 5xx=0 error_rate=0.000%
All QA-06 thresholds passed.
```

## 4. Чистая установка строго по документированным шагам

Свежая БД `logbook_t30_install`: `db:migrate` → `db:seed` (seed завершает
`ANALYZE`; проверено `last_analyze` не `never`) → API → тот же loadtest:

`install-analyzed.log` / `install-analyzed.json`:

```
scenario   count    p50     p95     p99     max
read         4132    48.0    74.3    91.2   389.0
changes      1251   105.6   142.2   182.7   351.0
push         2401   281.8   358.3  2506.1  4532.8
snapshot      426   130.9   181.1   212.1   383.4
requests=8210 rps=136.0 2xx=8210 4xx=0 5xx=0 error_rate=0.000%
All QA-06 thresholds passed.
```

**F-04 (mixed push):** p95 350.1–358.3 мс после ANALYZE (два прогона), порог 400
пройден. Cold-прогон 419.1 мс > 400 — это следствие отсутствия статистики, а не
маскировка: finding зафиксирован, обязательный ANALYZE закрывает его.

## 5. Loadtest-режим и production-лимиты (F-02)

Loadtest-режим: `LOADTEST_RATE_LIMIT_DISABLED=true` в API **только для
NODE_ENV≠production**; `env.ts` отклоняет его в production. Это позволяет измерять
latency, не получая 429 от per-IP лимитера.

Production-лимиты проверены отдельно на том же API (`3111`):
`RATE_LIMIT_ENABLED=true`, `RATE_LIMIT_MAX=300`, `AUTH_RATE_LIMIT_MAX=20`,
`LOADTEST_RATE_LIMIT_DISABLED=false`, 20 VU, 15 с:

`prod-rate-limit.log` / `prod-rate-limit.json`:

```
requests=35553 rps=2370.0 2xx=291 4xx=35262 5xx=0 network=0 error_rate=99.182%
THRESHOLD FAILURES: error rate 99.182% >= 0.1%
```

Это ожидаемый результат: 99.18 % запросов получили 429 (rate limit работает).
Пример ответа (`rate-limit-429.headers`/`.body`):

```
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 300
X-RateLimit-Remaining: 0
Retry-After: 37
{"error":{"code":"E-RATE-01","message":"Слишком много запросов. Повторите позже.","request_id":"..."}}
```

Performance-пороги в этом режиме **не применяются** (это проверка лимитера, не
пропускной способности); для latency используется loadtest-режим.

## 6. Выводы и файлы

- F-01 закрыт: `ANALYZE` — обязательный шаг seed/install (`db:seed` включает его,
  `db:analyze` — для установки без seed); cold-дефект воспроизведён и закрыт.
- F-02 закрыт: loadtest-режим с явным обходом лимитера (запрещён в production) +
  отдельная проверка production-лимитов (429/E-RATE-01/Retry-After).
- F-04 зафиксирован: push p95 350.1–358.3 после ANALYZE (pass), cold 419.1 (fail);
  оптимизация не потребовалась, finding не маскировался.
- Остаточное: p99 push ~2.5 с (audit/fsync) — отдельный риск, не p95-порог;
  production-rate-limit тест намеренно не является performance-тестом.

Файлы: `cold-no-analyze.{log,json}`, `after-analyze.{log,json}`,
`install-analyzed.{log,json}`, `prod-rate-limit.{log,json}`,
`rate-limit-429.{headers,body}`.
