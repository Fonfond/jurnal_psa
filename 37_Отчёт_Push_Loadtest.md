# Отчёт 37. Батчевый push и повторный PostgreSQL loadtest (t17, QA-06)

| Параметр | Значение |
|---|---|
| Дата | 25.11.2026; дополнение t30 — 27.11.2026 |
| Задача | t17 [batch-push-loadtest]; t30 [F-01/F-02/F-04] |
| Статус | Push-блокер t12 закрыт (p95 279,6 мс); t30: cold без ANALYZE — finding, после ANALYZE p95 350–358 мс (pass) |
| Миграции | `0013_batch_journal_seq.sql`, `0014_journal_sequences.sql` (после `0012`) |
| Стенд | PostgreSQL 15.15, 20 VU, 50 ops/push, 30 с; API один инстанс, pool 28 |
| Проверка | t17: 259 тестов; t30 (27.11): 306 тестов (28 shared / 125 API / 153 web), typecheck/build |

## 1. Причина блокера (t12)

`SyncService.push` выполнял отдельную транзакцию на каждую операцию (50 commit/fsync
на push), `journal_seq` выдавался UPSERT-ом в `journal_counters` (сериализация строки
журнала), аудит писался построчно с advisory lock и отдельным commit. При 20 VU
push 50 ops давал p95 5,1–5,3 с.

## 2. Что изменено

1. **Одна транзакция на батч + savepoint на операцию.** `rejected`/`conflict`
   откатывают только свой savepoint; идемпотентность `op_id` проверяется и
   пишется в той же транзакции; повторный батч возвращает `duplicate:true`.
2. **Блочная выдача `journal_seq`.** Для каждого журнала — PostgreSQL sequence
   `journal_seq_<uuid>` (миграция 0014); блок резервируется одним
   `nextval(...) FROM generate_series(1,N)` без блокировки строки. Триггер 0013/0014
   не трогает `journal_counters` для явно переданных seq; `journal_counters`
   остаётся для обратной совместимости/fallback. Новые журналы создают sequence
   в `JournalsService.create`.
3. **Bulk-INSERT.** Для типового офлайн-батча (entry create без наряда/заземления)
   записи вставляются одним `jsonb_to_recordset` INSERT, change_log — одним
   INSERT, idempotency — одним INSERT; результат маппится по id. Остальные
   операции идут через per-op savepoint.
4. **Коалесцирующий audit-writer.** Батч собирает audit-события в буфер; writer
   объединяет события конкурентных push в одну транзакцию: один advisory lock и
   один multi-row INSERT на поток, hash-цепочка сохраняется. Audit reads и
   `/admin/audit/verify` вызывают `flushPending`, shutdown — тоже. Компромисс:
   бизнес-батч коммитится до записи аудита; при аварии процесса между commit и
   flush событие аудита может потеряться (задокументировано).
5. **Device last_seen** обновляется фоново с throttling 30 с вне критической
   транзакции; **conditional update** убран из горячего пути.
6. **Индексы/порядок аудита:** исправлена сортировка hash-chain верификации
   (`audit_events.stream_seq` вместо текстового алиаса) — иначе при >9 событиях
   в потоке проверка ложно падала; audit payload канонизируется (Date→ISO,
   undefined→null), чтобы hash совпадал с JSONB.

## 3. Результат нагрузочного прогона (точный вывод)

Стенд: свежая БД `logbook_t17_evidence` (миграции 0001–0014, seed + scale fixture
5 003 пользователя / 20 005 записей), API `http://127.0.0.1:3104/v1`,
`DATABASE_POOL_MAX=28`, 20 VU, 50 ops/push, ramp 3 с, 30 с.

```
Load test: base=http://127.0.0.1:3104/v1 duration=30000ms concurrency=20 ramp=3000ms
Sessions ready: 3; devices registered

scenario   count    p50     p95     p99     max
read            0       0       0       0       0
changes         0       0       0       0       0
push          2207   211.7   279.6  2207.4  2811.9
snapshot        0       0       0       0       0
requests=2207 rps=73.1 2xx=2207 4xx=0 5xx=0 network=0 error_rate=0.000%
All QA-06 thresholds passed.
Result JSON: C:\jurnal\.data\pg15\results\load-2026-11-25T04-02-43-189Z.json
```

Порог QA-06 push 50 ops ≤400 мс выполнен с запасом (p95 279,6 мс; было 5 306,7).
Смешанный профиль (read 50 / changes 15 / push 30 / snapshot 5, 60 с, та же схема):
push p95 **372,1 мс** ✅; read p95 340 мс (порог 300) и changes p95 834 мс (порог
500) в этом прогоне не уложились — следствие выросшей пропускной способности push
и объёма change_log; чтения на 40k записей в t12 проходили. Отмечено как остаток
QA-06, не блокер push.

## 4. Влияние 0012 (retention/WORM)

`0012_retention_export.sql` применяется на схеме прогона (0001–0014). Триггеры
0012 — `BEFORE DELETE` на `journal_entries` (retention guard) и WORM-триггеры на
`export_jobs`/`archive_manifests`; push не удаляет записи и не пишет export_jobs,
поэтому на горячий путь не влияют (подтверждено одинаковым p95 до/после
применения 0012 в процессе замера). `0012` не добавляет commit/lock в push.

## 5. Тесты и проверки

- Новый `apps/api/test/sync-batch.spec.ts` (3): 50 creates одним батчем, уникальные
  подряд `journal_seq`, sequence +50, идемпотентный replay без новых номеров,
  mixed batch с savepoint-изоляцией, audit chain ok.
- `db.spec`: миграции 0001–0014, идемпотентность.
- API suite — 97 тестов, 16 suites; root — shared 28 / API 97 / web 134 = 259; typecheck 0;
  build ok (527,53 КБ / 151,77 КБ gzip).
- Аудит: `sync-batch` и `retention-export` проверяют `audit_events` после flush и
  `/admin/audit/verify`.

## 6. Остаток

- Async audit-writer: нет атомарности audit с бизнес-транзакцией (по требованию
  t12 допустим асинхронный writer); нужен мониторинг строки
  `audit async writer failed` и, при требовании 100% атомарности, вернуть
  синхронный flush с потерей порога p95.
- `journal_seq` при откате всей транзакции может иметь разрывы (sequence
  нетранзакционна); для журнала допустимо, зафиксировать в правилах.
- Смешанный профиль read/changes под высокой push-нагрузкой требует отдельной
  оптимизации (курсор changes, кэш чтений).

## 7. Обновление REP-06/t29 (27.11.2026)

Аудит переведён на durable outbox; `journal_seq` — sequence-блоки с явной
политикой разрывов при полном откате/аварии (`0016`), без сериализации на
`journal_counters`. Повторный прогон 20 VU × 50 ops на свежей БД 0001–0016:

```
push 2295, p50 192,5 / p95 349,1 / p99 1614,9 / max 2081,7 мс, 0 ошибок, 76,1 rps
All QA-06 thresholds passed.
```

Порог 400 мс снова выполнен (промежуточный gapless-вариант t23 давал 620,2 мс и
отменён). Дубликатов и отрицательных `journal_seq` нет; upgrade 0014→0016
проверен (`migration-upgrade.spec`), B-10 backfill сохранён. Подробно —
`42_Отчёт_REP-06.md`.

## 8. t30: cold install, ANALYZE и rate-limit loadtest (27.11.2026)

Задача F-01/F-02/F-04 из t28. Стенд: PG 15.15, Windows, один API, pool 28;
20 VU, 60 с, ramp 3 с, `MIX=read:50,changes:15,push:30,snapshot:5`, 50 ops/push.
Точные шаги, env и JSON — [docs/loadtest/t30/README.md](docs/loadtest/t30/README.md).

### 8.1. Cold fresh PG 0001–0017 без ANALYZE — FAIL (finding F-01)

```
read      p95 247.8, changes p95 612.1, push p95 419.1, snapshot p95 192.6
requests=5264 rps=87.5 2xx=5264 4xx=0 error_rate=0.000%
THRESHOLD FAILURES: changes 612.1 > 500; push 419.1 > 400
```

До нагрузки `last_analyze=never`, `pg_statistic=0` для `change_log`. В ходе
прогона autoanalyze успел сработать, но ранняя часть шла без статистики.
Дефект не маскируется: cold-install без ANALYZE порог не проходит.

### 8.2. После ANALYZE — PASS

```
read      p95 71.8, changes p95 139.2, push p95 350.1, snapshot p95 168.4
requests=8140 rps=135.0 2xx=8140 4xx=0 error_rate=0.000%
All QA-06 thresholds passed.
```

Чистая установка по документированным шагам (`db:migrate` → `db:seed`, seed
завершается ANALYZE) и тот же loadtest:

```
read      p95 74.3, changes p95 142.2, push p95 358.3, snapshot p95 181.1
requests=8210 rps=136.0 error_rate=0.000%
All QA-06 thresholds passed.
```

**F-04:** mixed push p95 350.1–358.3 мс после ANALYZE (порог 400 пройден);
cold 419.1 мс — следствие отсутствия статистики. Оптимизация не потребовалась,
finding зафиксирован.

### 8.3. Rate limit (F-02)

- Loadtest-режим: `LOADTEST_RATE_LIMIT_DISABLED=true`; `env.ts` **запрещает** его
  в production (fail-closed). Позволяет измерить latency без 429.
- Production-лимиты отдельно: `RATE_LIMIT_MAX=300`, `AUTH_RATE_LIMIT_MAX=20`,
  20 VU, 15 с → **99.18 % 429** (`E-RATE-01`, `Retry-After`, `X-RateLimit-*`);
  это проверка лимитера, не performance-порог.

Артефакты: `docs/loadtest/t30/{cold-no-analyze,after-analyze,install-analyzed,prod-rate-limit}.{log,json}`,
`rate-limit-429.{headers,body}`. Обязательный шаг: `npm run db:analyze`
(или ANALYZE в psql) после migrate/bootstrap; `db:seed` делает это автоматически.

### 8.4. t32: fixture/load ANALYZE residual (27.11.2026)

`db:seed` ANALYZE не покрывает scale fixture и сам load, которые добавляют
данные после него. Поэтому fixture-ANALYZE + первый load всё ещё дают
changes p95 **851.5** (fail); после **post-load** `db:analyze` — **138.5** (pass).
Независимый cold fresh по исправленной процедуре (fixture ANALYZE → warm-up
60 с без учёта → ANALYZE → измерение) — changes **136.6**, push **362.5**, pass.

Исправление: `scale-fixture.mjs` делает ANALYZE после bulk; `loadtest.mjs` —
ANALYZE перед стартом и после `WARMUP_MS`; 35 §6.5/6.6 требует `db:analyze`
после bulk/import/restore/прогрева перед production-трафиком. Первый load после
fixture без post-load ANALYZE не считается приёмочным. Подробно —
`docs/loadtest/t32/README.md`.
