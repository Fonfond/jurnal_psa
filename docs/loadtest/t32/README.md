# t32 / F-01 residual: ANALYZE после bulk/scale/load и холодный retest

| Параметр | Значение |
|---|---|
| Дата | 27.11.2026 |
| Задача | t32 (F-01 residual из t31) |
| Стенд | PostgreSQL 15.15 (`.data/pg15`, 55432, TLS), Windows, один API, pool 28 |
| Нагрузка | 20 VU, 60 с, ramp 3 с, `MIX=read:50,changes:15,push:30,snapshot:5`, 50 ops/push |
| Итог | fixture-ANALYZE **недостаточен**: первый load после scale даёт changes p95 851.5 (fail); после **post-load** ANALYZE / warm-up+ANALYZE — 138.5/136.6 (pass) |

## 1. Причина residual

`db:seed` делает `ANALYZE` только для seed-данных. `scale-fixture.mjs` добавляет
5 000 пользователей / 20 000 записей **после** seed, а сам loadtest создаёт ещё
десятки тысяч `change_log`/entries во время измерения. Планировщик, получивший
статистику до этих вставок, выбирает seq scan на `/sync/changes`; p95 выходит за
500 мс. Поэтому ANALYZE нужен **после bulk/scale/import и после прогрева нагрузки**,
непосредственно перед измерением/боевым трафиком.

## 2. Точная процедура (исправленная)

```powershell
# 1. Чистая БД
createdb -h 127.0.0.1 -p 55432 -U logbook logbook_t32_verify
$env:DATABASE_URL='postgresql://logbook:logbook@127.0.0.1:55432/logbook_t32_verify'
$env:DATABASE_SSL_MODE='require'; $env:NODE_ENV='development'

npm run db:migrate                # 0001–0017
npm run db:seed                   # seed + ANALYZE (только seed-данные)

# 2. Bulk/scale — ПОСЛЕ seed; fixture сам делает ANALYZE (t32), но это ещё не всё
node scripts/pg/scale-fixture.mjs
npm run db:analyze                # обязательный повторный ANALYZE после fixture/import

# 3. API в loadtest-режиме (rate limit bypass запрещён в production)
$env:PORT='3116'; $env:DATABASE_POOL_MAX='28'; $env:RUN_MIGRATIONS_ON_START='false'
$env:RATE_LIMIT_ENABLED='true'; $env:LOADTEST_RATE_LIMIT_DISABLED='true'
node apps/api/dist/main.js

# 4. Холодная приёмка: прогрев (не измеряется) + ANALYZE + измерение.
#    loadtest.mjs сам делает ANALYZE перед стартом и после WARMUP_MS.
$env:BASE_URL='http://127.0.0.1:3116/v1'
$env:DURATION_MS='60000'; $env:CONCURRENCY='20'; $env:RAMP_MS='3000'
$env:WARMUP_MS='60000'
$env:MIX='read:50,changes:15,push:30,snapshot:5'
node scripts/pg/loadtest.mjs
```

Для production: после CSV/JSON-импорта, массового создания пользователей,
restore или иного bulk — `npm run db:analyze` **до** открытия трафика. Если трафик
уже шёл (например, первый прогрев), ANALYZE выполняется после прогрева и до
измерения/приёмки.

## 3. Результаты (не маскируем)

### 3.1. Fixture-ANALYZE, но без post-load ANALYZE — FAIL

`cold-fixture-analyze-first-run.log` / `.json`:

```
ANALYZE before load: done in 494 ms
read p95 248.3, changes p95 851.5, push p95 368.6, snapshot p95 181.5
requests=6017 2xx=6017 error_rate=0.000%
THRESHOLD FAILURES: changes p95 851.5ms > 500ms
```

То есть `db:seed` + fixture ANALYZE **недостаточны**: loadtest сам добавил данные,
статистика снова устарела. Это остаточный F-01, он зафиксирован, а не спрятан.

### 3.2. После post-load `npm run db:analyze` — PASS

`cold-post-load-analyze.log` / `.json`:

```
ANALYZE complete: planner statistics refreshed
ANALYZE before load: done in 1382 ms
read p95 70.0, changes p95 138.5, push p95 353.0, snapshot p95 170.9
requests=8126 2xx=8126 error_rate=0.000%
All QA-06 thresholds passed.
```

### 3.3. Независимый cold fresh по исправленной процедуре (warm-up+ANALYZE) — PASS

Свежая `logbook_t32_verify`: migrate → seed → scale fixture (ANALYZE) →
`WARMUP_MS=60000` (прогрев не измеряется) → ANALYZE → измерение:

`cold-verify-warmup-analyze.log` / `.json`:

```
ANALYZE before load: done in 486 ms
Warm-up 60000ms (not measured) ...
ANALYZE before load: done in 1799 ms
Warm-up complete; statistics refreshed before measurement
read p95 70.5, changes p95 136.6, push p95 362.5, snapshot p95 162.3
requests=8294 2xx=8294 error_rate=0.000%
All QA-06 thresholds passed.
```

## 4. Изменения harness/процедуры

- `scripts/pg/scale-fixture.mjs`: `ANALYZE` после bulk-вставки (и после `--clean`);
  `SCALE_SKIP_ANALYZE=1` — только для воспроизведения дефекта.
- `scripts/pg/loadtest.mjs`: `ANALYZE` перед замером при наличии `DATABASE_URL`;
  `WARMUP_MS` — прогрев без учёта в метриках, затем повторный `ANALYZE`;
  `LOADTEST_ANALYZE=0` — только для finding-прогона.
- 35 §6.5/6.6: обязательный `db:analyze` после seed/fixture/import/restore и
  перед production-трафиком; точный порядок команд.
- `docs/loadtest/t30/README.md`: ссылка на t32 residual.

Артефакты: `cold-fixture-analyze-first-run.{log,json}`,
`cold-post-load-analyze.{log,json}`, `cold-verify-warmup-analyze.{log,json}`,
`scale-fixture-analyze.log`, `verify-scale-fixture.log`.
