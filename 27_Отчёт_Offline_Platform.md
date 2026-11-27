# 27. Отчёт: офлайн-платформа (per-user IndexedDB, кэш руководителя, Background Sync)

| Параметр | Значение |
|---|---|
| Версия | 1.0 |
| Дата | 25.11.2026 |
| Автор | Frontend / PWA Engineer |
| Задача | t10 `[offline-platform]` — разделение локальных данных по пользователю/журналу, кэш руководителя, кастомный SW Background Sync / Periodic Sync, миграции Dexie, тесты |
| Закрывает | SYN-02 (per-user IDB + кэш руководителя + lock/logout), SYN-04 (снимок → миграция → проверка → откат), SYN-05 (кастомный SW, Background Sync / Periodic Sync, iOS-fallback) |
| Зависимости | t2 (auth-platform: OIDC, устройства, ЭП), t3 (мультижурнальность), t4 (смены) — учтены в схеме, движке и тестах |
| Статус | Реализовано и проверено; SYN-01/SYN-03/SYN-06/SYN-07/SYN-08 остаются открытыми (раздел 7) |

---

## 1. Итог

Локальные данные больше не лежат в одной общей базе браузера:

1. **Per-user IndexedDB (SYN-02).** Каждая учётная запись получает собственную базу `logbook:user:<user_id>`; при смене пользователя приложение открывает другую базу, поэтому записи, визы, черновики, очередь и справочники одного аккаунта физически недоступны другому.
2. **Device-scoped IndexedDB.** Идентичность устройства (`device_id`, `install_id`, `device_key:*`, `device_node`, `hlc_last`, CSRF-токен для SW, активный пользователь) вынесена в `logbook:device`. Регистрация устройства (ADR-23) переживает вход/выход и смену пользователя, а фоновая отправка из service worker знает, чью очередь отправлять.
3. **Кэш руководителя (ADR-16, OQ-21).** Для `supervisor`/`admin` при синхронизации кэшируются последние **7 дней** каждого доступного журнала и визы; бюджет — **15 МиБ** на пользователя (по равной доле на журнал), вытеснение — по возрасту и объёму, локальные несинхронизированные правки не перезаписываются. Флаг `features.supervisor_cache` в `/v1/me` теперь включается для этих ролей.
4. **Безопасные миграции Dexie (SYN-04, ADR-18).** Перед апгрейдом схемы (v3 → v4) снимается снимок всех stores в отдельную базу, после апгрейда проверяются счётчики (и подключаемая проверка), при расхождении данные восстанавливаются из снимка, а приложение не стартует с повреждённым кэшем. Проверено на 10 000 записей.
5. **Кастомный service worker (SYN-05, ADR-03).** `vite-plugin-pwa` переведён на `injectManifest`; SW кэширует оболочку и `/offline.html`, никогда не кэширует `/v1/`, обрабатывает `sync` и `periodicsync` теги `logbook-sync` и сам отправляет очередь (`/v1/sync/push`) после закрытия вкладки. Для iOS и браузеров без Background Sync — честное сообщение и fallback на таймер/фокус.
6. **Разделение «блокировка» и «выход» (ADR-10).** `lock()` закрывает базу, но сохраняет все данные и файл БД; `logout()` удаляет базу пользователя целиком (включая `journal_reviews`, `meta`, кэш руководителя и черновики).
7. **Совместимость с t3/t4.** Данные из старой общей базы `logbook` переносятся в персональные базы при первом входе (только строки этого пользователя, остальные остаются для других аккаунтов; полностью перенесённая база удаляется после снимка). `write` из outbox теперь передаёт `entity_type` операции, движок обрабатывает `merged_shift`, а `applyChanges` — изменения смен; в Dexie v4 добавлен store `shifts`.

---

## 2. Изменения по слоям

### 2.1. Хранилище (`apps/web/src/db`)

| Файл | Изменение |
|---|---|
| `schema.ts` | Dexie **v4**: `entries[journal_id+performed_at]`, store `supervisor_cache`, store `shifts`; нормализация `journal_id`/`sync_status`; `LEGACY_DB_NAME`, `CLIENT_SCHEMA_VERSION`; реестр активной БД: `getDb`/`setActiveDatabase`, экспорт `db` — прокси на активную пользовательскую базу (все существующие экраны/репозитории продолжают работать без изменений) |
| `device-db.ts` | Новая база `logbook:device` (store `meta`): `getDeviceMeta`/`setDeviceMeta`, `DEVICE_IDENTITY_KEYS`, `deleteDatabase` (ожидает завершения удаления), `closeDeviceDatabase` |
| `migration.ts` | `dumpDatabase`, `storeCounts`, `writeSnapshot`/`readSnapshot`/`restoreFromSnapshot`, `deleteRowsFromDatabase`, `openWithMigrationSnapshot`; отчёт `MigrationReport` (`fresh/current/upgraded/rolled_back/failed`, `verification`, `snapshot`, `restored_rows`, `duration_ms`), нормализация raw-версии IndexedDB (Dexie хранит `version*10`), запись `migration_report` в `meta` |
| `user-db.ts` | `userDatabaseName`, `activateUserDatabase`, `adoptLegacyDatabase`, `closeActiveDatabase` (lock), `deleteUserDatabase` (logout), `activeUserId`, `rememberUser`/`listKnownUsers`, `listUserDatabases`, `resetActiveDatabase` (тесты) |
| `repositories.ts` | Идентичность устройства и HLC-узел читаются/пишутся в `logbook:device`; `clearLocalUserData` очищает **все** stores пользователя; `getPersistedCsrfToken` для SW; `applyChanges` обрабатывает `entity_type='shift'` (конфликт при наличии локальной операции) |
| `supervisor-cache.ts` | Окно 7 дней, бюджет 15 МиБ, троттлинг 6 ч, `refreshSupervisorCache`, `evictJournalCache`, `readSupervisorCacheStatus`, `clearSupervisorCache`, `isSupervisorCacheRole`, `supervisorCacheEnabled` |

### 2.2. Синхронизация и service worker

| Файл | Изменение |
|---|---|
| `sync/engine.ts` | `currentUser`/`supervisorCacheFeature` в опциях; шаг `refreshSupervisorCacheIfNeeded` после push/pull (best effort); `entity_type` операции в push; `merged_shift` → `applyServerShift`; конфликт смены → `applyServerShift(..., { conflict })`/`markShiftConflict`; bootstrap кэширует смены через `api.shifts` |
| `sync/sw-flush.ts` | Отправка outbox из SW на «сыром» IndexedDB: активный пользователь и device key из `logbook:device`, CSRF из устройства, батчи ≤50, семантика applied/duplicate/conflict/rejected, backoff, `dead`, запись `sync_last_at`/`sync_error`, `sw_last_flush`; не создаёт БД, если её нет |
| `sync/background-sync.ts` | `BACKGROUND_SYNC_TAG`/`PERIODIC_SYNC_TAG` (`logbook-sync`), `detectSyncCapabilities` (включая iPadOS), `registerBackgroundSync` (не бросает, статус в device-meta), `unregisterPeriodicSync`, `syncCapabilitiesMessage` |
| `sync/triggers.ts` | Реальная регистрация Background/Periodic Sync при старте, `online` и `offline`; сообщение SW `LOGBOOK_SYNC` запускает pull; прежние триггеры (фокус, visibility, 5 мин) сохранены |
| `sw/service-worker.ts` | Кастомный SW: precache из `self.__WB_MANIFEST`, runtime cache статики, network-first для навигации с fallback `/offline.html`, NetworkOnly для `/v1/`, `sync`/`periodicsync` обработчики, `LOGBOOK_FLUSH`/`SKIP_WAITING` сообщения, уведомление вкладок (`LOGBOOK_SW_FLUSHED`, `LOGBOOK_SYNC`), повтор события при офлайне/retryable-ошибке |
| `vite.config.ts` | `strategies: 'injectManifest'`, `srcDir: 'src/sw'`, `filename: 'service-worker.ts'`; сборка SW проверена (`dist/service-worker.js`, precache 11 файлов) |
| `tsconfig.sw.json`, `package.json` | Отдельный typecheck для WebWorker-контекста SW; web typecheck = приложение + SW |

### 2.3. Аккаунт, UI и API

| Файл | Изменение |
|---|---|
| `stores/auth.ts` | `login`/`loadMe` активируют пользовательскую БД до выставления `user`; `lock()` сохраняет данные; `logout()` удаляет базу пользователя; состояние `locked` |
| `stores/sync.ts` | `SyncEngine` получает текущего пользователя; в store — статус кэша руководителя и Background Sync, действие «обновить кэш» |
| `screens/SyncScreen.tsx` | Карточки «Фоновая синхронизация» (capability-сообщение) и «Кэш руководителя» (период, записи, объём/бюджет, визы, обновление) |
| `components/Layout.tsx`, `LoginScreen.tsx` | Кнопка «Заблокировать», баннер заблокированной сессии |
| `api/client.ts` | CSRF-токен дублируется в device-мету для SW; `entries` принимает `from`/`to` |
| `api/auth.controller.ts` (API) | `features.supervisor_cache = role === 'supervisor' || role === 'admin'` (вместо `false`/TODO) |
| `api.e2e.spec.ts` (API) | Проверка флага для worker (false) и supervisor (true) |
| `styles.css` | `.card__header`, нижняя навигация на 6 пунктов (смена из t4) |

### 2.4. Документация

`24_Остаток_разработки.md` (v1.5, §4.7, статусы SYN-02/04/05), `05_Модель_данных.md` (§4.2, §7), `06_Контракт_API.md` (features), `RUNBOOK.md` (раздел 3.6, эксплуатация локальных данных), `09_Реестр_ADR.md` (статусы ADR-16/18), этот отчёт.

---

## 3. Ключевые решения

### 3.1. Границы баз

```
logbook:device          device_id, install_id, device_key:<id>, device_node, hlc_last,
                        csrf_token, active_user_id, last_user_id, known_users,
                        background_sync_status, sw_last_flush, legacy_adopted:<uid>
logbook:user:<uid>      entries, revisions, entry_workers, permits, dict_*, journals,
                        journal_reviews, shifts, outbox, conflicts, drafts, sync_state,
                        supervisor_cache, meta
logbook                 только для одноразового переноса старых данных (после переноса удаляется)
```

* Идентичность устройства не должна исчезать при logout: иначе каждый вход регистрировал бы новое устройство, а push отклонялся бы по `X-Device-Key`.
* Справочники/наряды — тоже per-user: их объём мал, зато нет утечки между аккаунтами и нет общего изменяемого кэша на устройстве.
* `db` в `schema.ts` — прокси на активную базу: экраны и репозитории не знают о переключении, а тесты продолжают работать с одной базой.

### 3.2. Жизненный цикл

| Событие | Действие |
|---|---|
| Вход / восстановление сессии | `activateUserDatabase(user.id)` → при необходимости snapshot-миграция → перенос legacy-данных → `active_user_id` в device-meta |
| Блокировка (`lock`) | `closeActiveDatabase()`: соединение закрыто, БД и все данные на диске; `active_user_id` сброшен (SW не отправит чужую очередь) |
| Выход с очисткой (`logout`) | `deleteUserDatabase(user.id)`: база удалена; device-база сохранена |
| Явная очистка без выхода | `clearLocalUserData()` очищает все stores пользовательской базы (включая `journal_reviews`, `meta`, кэш, смены) |
| Повреждение/сбой миграции | `openWithMigrationSnapshot` восстанавливает снимок, возвращает `rolled_back`, приложение показывает ошибку и не работает с повреждённым кэшем |

### 3.3. Кэш руководителя

* Окно — 7 дней на журнал; запросы `GET /v1/entries?from&to&journal_id&limit=100` с курсором, до 3000 записей на журнал и 30 страниц.
* Бюджет 15 МиБ на пользователя, делится между журналами поровну (минимум 1 МиБ на журнал). Вытеснение: сначала записи вне окна, затем самые старые из окна, пока объём не уложится в бюджет. Свои записи и записи с pending-операцией не удаляются.
* Обновление — при синхронизации не чаще раза в 6 часов (иначе `throttled`), кнопкой «Обновить кэш» — принудительно.
* Отдельно кэшируются визы журнала (`GET /v1/journal/reviews`) — best effort, ошибка виз не ломает кэш записей.
* Статус хранится в `supervisor_cache` и в `meta` (`supervisor_cache_status`, `supervisor_cache_at:<uid>`), отображается в S-12.
* `/v1/me` возвращает `features.supervisor_cache=true` только для `supervisor`/`admin`; клиент дополнительно проверяет роль (защита от старого API).

### 3.4. Миграция со снимком

1. `Dexie.exists(name)` — новая база создаётся сразу без снимка.
2. `dumpDatabase(name)` — чтение всех stores «сырым» IndexedDB без изменения схемы (версия пересчитывается из Dexie-формата `×10`).
3. Снимок пишется в `logbook:...#snapshot:<ts>` (store `stores` + `info`).
4. Dexie открывает базу — выполняется upgrade v3→v4.
5. Проверка: счётчики каждого store совпадают со снимком (+ подключаемый `verify`).
6. Успех — снимок удаляется, отчёт пишется в `meta.migration_report`. Ошибка — строки восстанавливаются из снимка, отчёт `rolled_back`, снимок остаётся для диагностики.

Проверено на 10 000 записей (10 001 строка снимка, апгрейд ~1,7 с в fake-indexeddb), на принудительном провале проверки (восстановлено 61 строка, база остаётся рабочей) и на исключении в upgrade (версия IndexedDB остаётся 3, данные восстановлены).

### 3.5. Service worker и честные ограничения

* `sync`-событие: SW сам отправляет очередь и просит открытые вкладки выполнить pull; при офлайне или retryable-ошибке событие отклоняется — браузер повторит его сам.
* `periodicsync`: тот же обработчик, тег `logbook-sync`, минимальный интервал 15 минут (страница передаёт свой интервал 5 минут).
* iOS (включая iPadOS с desktop-UA) не поддерживает ни Background Sync, ни Periodic Sync — UI прямо сообщает, что очередь уйдёт при следующем открытии приложения; таймер и focus остаются fallback.
* CSRF-токен для фоновой отправки хранится в `logbook:device` (не в localStorage), device key — там же; `fetch` идёт с `credentials: 'include'`.
* `/v1/` никогда не кэшируется; при навигации офлайн отдаётся оболочка или `/offline.html`.

---

## 4. Тесты

Новые файлы:

| Файл | Покрытие |
|---|---|
| `db/user-db.test.ts` | изоляция двух пользователей и журналов, lock сохраняет данные, logout удаляет базу, `clearLocalUserData` очищает все stores и не трогает device identity, перенос legacy-базы (только свои строки, device-ключи, удаление legacy после полного переноса и снимок) |
| `db/migration.test.ts` | fresh/current, апгрейд 10 000 записей со снимком и проверкой, отсутствие снимка после успеха, `rolled_back` при провале проверки, восстановление при исключении в upgrade (версия остаётся 3), явное чтение/восстановление снимка |
| `db/supervisor-cache.test.ts` | роли (worker/auditor выключены, supervisor/admin включены, флаг API), окно 7 дней, кэш по журналам, отсутствие перезаписи pending-правки, троттлинг/force, сохранение виз, вытеснение по бюджету и окну, сохранение своих записей |
| `sync/sw-flush.test.ts` | отправка с `X-Device-Key`/`X-CSRF-Token` и `entity_type`, shift-операции, conflict/rejected applied-семантика, `dead` для постоянных кодов, backoff при сетевой ошибке и временном отказе, 401 не трогает очередь, пропуски (нет пользователя/ключа/пусто/отложено), офлайн |
| `sync/background-sync.test.ts` | определение iOS/iPadOS, capability-сообщения, регистрация обоих тегов, устойчивость к отказу Periodic Sync, отсутствие SW, unregister |
| `sync/service-worker.contract.test.ts` | контракт SW: обработчики `sync`/`periodicsync`, общий flush, precache `__WB_MANIFEST`, `/offline.html`, NetworkOnly `/v1/`, retryable |
| `db/schema.test.ts` (обновлён) | Dexie v4, 18 stores, миграция v2→v4 |

Проверки (25.11.2026):

| Команда | Результат |
|---|---|
| `npm run typecheck --workspace @logbook/web` (app + SW) | exit 0 |
| `npm run test --workspace @logbook/web` | **81 passed** (15 файлов), включая 4 shift-теста t4 |
| `npm run test --workspace @logbook/api` | **66 passed** (10 suites), e2e с флагом `supervisor_cache` |
| `npm run typecheck --workspace @logbook/api` | exit 0 |
| `npm run build:web` | успешно: `dist/service-worker.js` (8,5 КБ), precache 11 файлов / 465,76 КиБ, JS 451,86 КБ / 135,75 КБ gzip |

---

## 5. Приёмка по критериям SYN

| ID | Критерий | Доказательство |
|---|---|---|
| SYN-02 | Смена пользователя не показывает чужие записи/визы; logout очищает все пользовательские stores; lock сохраняет данные; тест двух пользователей | `db/user-db.test.ts` (изоляция, lock/logout, полная очистка), разные БД `logbook:user:<uid>`, `clearLocalUserData` по всем таблицам |
| SYN-04 | Снимок → проверка → откат; тест с 10 000 записей | `db/migration.test.ts` (10k, forced verify failure, throw в upgrade), `db/migration.ts` |
| SYN-05 | Отправка после закрытия вкладки; на iOS честное сообщение и fallback; тест SW | `sync/sw-flush.test.ts`, `sync/background-sync.test.ts`, контракт SW, сборка `dist/service-worker.js` |
| ADR-16 / OQ-21 | Кэш руководителя 7 дней, отдельный бюджет 10–20 МБ | `db/supervisor-cache.test.ts`, 15 МиБ, UI S-12, флаг `/me` |

---

## 6. Ограничения и риски

| ID | Риск | Митигация/статус |
|---|---|---|
| OQ-21 | Кэш руководителя и per-user IDB не согласованы с заказчиком/ИБ письменно | Реализовано по ADR-16 (7 дней/15 МиБ); решение зафиксировать до этапа C |
| SYN-03 | IndexedDB не шифруется (ADR-20) | Не входит в t10; PIN/разблокировка — AUTH-03, политика устройств — OQ-09 |
| R-14 | CSRF-токен хранится в IndexedDB устройства | CSRF — не секрет сессии; cookie остаётся HttpOnly; при logout токен стирается (`setCsrfToken('')`) |
| R-15 | iOS полностью лишён фоновой отправки | Честное сообщение в S-12, fallback таймер/фокус, ограничение задокументировано в RUNBOOK |
| R-16 | Бюджет 15 МиБ может быть вытеснен браузером (iOS/Safari) | Объём оценивается и ограничивается; `navigator.storage.persist()` — SYN-01 (PoC G2), не входит в t10 |
| R-17 | Снимок миграции временно удваивает объём | Снимок удаляется после проверки; при ошибке хранится для диагностики |
| R-18 | Персональные HLC-часы у каждого пользователя | Уникальность узла сохраняется, порядок в рамках пользователя монотонен; серверный merge не зависит от общего узла |

---

## 7. Что осталось за рамками t10

* **SYN-01 (P0):** PoC G2 — квоты, `navigator.storage.persist()`, экспорт/восстановление, повреждение IDB, iOS-вытеснение, две вкладки.
* **SYN-03 (P0):** шифрование IDB или официальная компенсация (ИБ/OQ-09).
* **SYN-06 (P2):** очистка tombstones 90 дней, полный resync по устаревшему курсору, retention `change_log`.
* **SYN-07 (P1):** явный лимит тела push, 413, нагрузочный тест 100 операций.
* **SYN-08 (P1):** аварийный экспорт локальных данных и индикатор несинхронизированных записей.
* **AUTH-03:** офлайн-разблокировка/PIN — `lock()` уже разделён с logout, но офлайн-вход после блокировки появится в AUTH-03.

---

## 8. Файлы

**Код:** `apps/web/src/db/{schema,device-db,migration,user-db,repositories,supervisor-cache}.ts`, `apps/web/src/sync/{engine,triggers,background-sync,sw-flush}.ts`, `apps/web/src/sw/service-worker.ts`, `apps/web/src/stores/{auth,sync}.ts`, `apps/web/src/screens/{SyncScreen,LoginScreen}.tsx`, `apps/web/src/components/Layout.tsx`, `apps/web/src/api/{client,types}.ts`, `apps/web/{vite.config.ts,tsconfig.json,tsconfig.sw.json,package.json}`, `apps/web/src/{styles.css,vite-env.d.ts,test/setup.ts}`, `apps/api/src/auth/auth.controller.ts`, `apps/api/test/api.e2e.spec.ts`.

**Тесты:** `apps/web/src/db/{user-db,migration,supervisor-cache,schema}.test.ts`, `apps/web/src/sync/{sw-flush,background-sync,service-worker.contract}.test.ts`.

**Документы:** `27_Отчёт_Offline_Platform.md`, `24_Остаток_разработки.md`, `05_Модель_данных.md`, `06_Контракт_API.md`, `RUNBOOK.md`, `09_Реестр_ADR.md`.
