# Отчёт по итерации Phase 0 + Phase A

| Параметр | Значение |
|---|---|
| Дата | 24.11.2026 |
| Статус | Phase 0 (demo) и Phase A (ядро C-08…C-10, conflicts, тесты) завершены |
| Тесты | **82** (21 shared + 35 API + 26 web), все pass |
| Typecheck | shared / api / web — без ошибок |
| Сборка | shared + API + web; 384,86 КБ JS / 118,65 КБ gzip; precache 11 файлов / 398,82 КиБ |
| Следующее | Phase B — PoC G1/G2/G3, затем Phase C — PostgreSQL 15 |

---

## 1. Phase 0 — демонстрационный комплект

Создан каталог `demo/`:

| Файл | Назначение |
|---|---|
| `demo/README.md` | запуск, роли, сценарий, ограничения |
| `demo/start.ps1` | сборка shared, seed, запуск API + web, открытие браузера |
| `demo/reset.ps1` | удаление **только** `.data/pglite` и повторный seed |
| `demo/import-permits.mjs` | CSV-импорт от администратора, идемпотентный |
| `demo/import-permits.ps1` | обёртка для запуска импорта |
| `demo/permits.csv` | два демонстрационных наряда |
| `demo/presentation.md` | сценарий показа на 5–7 минут |

Команды:

```powershell
npm run demo:start
npm run demo:reset
npm run demo:permits
```

Проверено:

- `demo/reset.ps1` пересоздаёт PGlite и выдаёт `users=3, permits=3, entries=5`;
- `demo/import-permits.mjs` при запущенном API импортирует `2`, повторный запуск — `updated=2`, `skipped=0`;
- PowerShell-скрипты проходят синтаксический разбор; сообщения сделаны ASCII для совместимости с Windows PowerShell 5.1.

---

## 2. Phase A — закрытые правила merge

### 2.1. C-08: серверная коррекция времени

- В `packages/shared/src/schemas.ts` добавлено **необязательное** `accept_server_time`.
- В `decideMerge`:
  - если `performed_at_source = 'server_corrected'`, ручное изменение `performed_at`/`performed_at_source` без `accept_server_time=true` **не применяется**;
  - создаётся конфликт `server_correction_requires_consent`;
  - при `accept_server_time=true` применяется ручное время, источник становится `manual`.
- В UI S-03 для такой записи показывается предупреждение и чекбокс согласия.
- Контракт `/v1` не ломается: поле аддитивное и не хранится в записи.

Ограничение: API серверной коррекции пока отсутствует; политика готова к появлению такого административного сценария.

### 2.2. C-09: аннулирование наряда

- `sync.service` читает актуальный `permits.status` по `permit_id`.
- При `annulled`:
  - запись **сохраняется**;
  - `permit_status_at_sync = 'annulled'`;
  - `permit_risk_flag = true`;
  - причина риска сохраняется пользовательская, иначе ставится системная «Наряд аннулирован после офлайн-записи»;
  - создаётся `conflict_record` с полем `permit_status_at_sync`, `resolution='pending'`;
  - пишется audit `entry.permit_annulled`.
- Покрыт и create, и update после аннулирования.
- Уведомление руководителя (push/email) — `TODO(notification)`, вне текущего объёма.

### 2.3. C-10: пост-merge валидация

- `validateMergedEntry` проверяет:
  - длину текста;
  - voice → `asr_engine`;
  - risk → `permit_risk_reason`;
  - `permit_id` XOR `permit_number_raw`;
  - `linked` → `permit_id`;
  - диапазон `performed_tz_offset_min`.
- Невалидный кандидат **не пишется** в БД: версия не растёт, возвращается `status='conflict'`, поле `_entity`, reason `invalid_merge:<...>`, создаётся pending conflict.
- Это исключает падение в DB constraint/`E-SRV-01`.

### 2.4. Конфликты из `GET /sync/changes`

- `applyChanges` при локальном pending-op сравнивает локальную и серверную запись по пользовательским полям.
- Создаёт `conflict_records` (`pending`) с local/remote value и HLC, дедуплицирует pending-записи.
- Tombstone при pending-op также даёт конфликт `_entity`.
- S-13 теперь получает такие конфликты, а не только конфликты push.

### 2.5. Остальные тесты

- `failOperation` при `attempts=9` → `dead`, `attempts=10`, `next_attempt_at=null`.
- API e2e проверяет серверные ревизии и diff.
- Web-тест проверяет `applySnapshot` с `dict_templates`.
- FR-PRM-11: `PERMIT_VISIBILITY_MODE=all|participant`; в `participant` worker видит только наряды с участием, admin — все. Default `all` сохраняет текущее поведение.
- Тест `permits-visibility.spec.ts` работает с отдельным env и не влияет на остальные наборы.

---

## 3. Изменённые файлы

| Файл | Изменение |
|---|---|
| `packages/shared/src/schemas.ts` | `accept_server_time` |
| `apps/api/src/sync/merge.ts` | C-08, `validateMergedEntry` |
| `apps/api/src/sync/sync.service.ts` | C-09, C-10, pending conflicts, permit visibility в changes |
| `apps/api/src/permits/permits.service.ts` | FR-PRM-11 list/get |
| `apps/api/src/permits/permits.controller.ts` | actor в get |
| `apps/api/src/config/env.ts` | `PERMIT_VISIBILITY_MODE` |
| `apps/api/test/merge.spec.ts` | C-08/C-10 unit-тесты |
| `apps/api/test/api.e2e.spec.ts` | C-08/C-09/C-09-update/C-10, ревизии |
| `apps/api/test/permits-visibility.spec.ts` | FR-PRM-11 |
| `apps/web/src/db/repositories.ts` | conflicts из changes, consent в payload |
| `apps/web/src/screens/EntryEditorScreen.tsx` | C-08 consent UI |
| `apps/web/src/db/repositories.test.ts` | changes-conflict, templates |
| `apps/web/src/sync/engine.test.ts` | dead после 10 попыток |
| `demo/*` | демонстрационный комплект |
| `package.json`, `.env.example` | demo-скрипты, `PERMIT_VISIBILITY_MODE` |

БД-миграции не добавлялись: использованы существующие `conflict_records`, `journal_entries`, `permits`.

---

## 4. Результаты проверок

| Команда | Результат |
|---|---|
| `npm test` | **82 pass**: 21 shared + 35 API + 26 web |
| `npm run typecheck` | без ошибок |
| `npm run build` | shared + API, web 384,86 КБ / 118,65 КБ gzip, precache 398,82 КиБ |
| `demo/reset.ps1` | seed `3/3/5` |
| `demo/import-permits.mjs` | imported=2; повторно updated=2 |

API-наборы: `api.e2e` (15), `merge` (10), `db` (4), `health` (1), `permits-unit` (4), `permits-visibility` (1) = 35.
Web: API client 4, schema 3, repositories 7, engine 8, Login 2, Entries 2 = 26.

---

## 5. Ограничения и TODO

| ID | Текущее состояние |
|---|---|
| C-08 | API серверной коррекции отсутствует; политика готова, но ветка `server_corrected` пока заполняется только тестом/БД |
| C-09 | Нет push/email уведомления руководителю; есть conflict + audit |
| C-10 | Конфликт `_entity`; UI S-13 показывает поле, но массового «разобрать всё» нет |
| FR-PRM-11 | `participant` реализован для worker в list/get/changes; supervisor-политика — TODO |
| G3 | Код C-08…C-10 закрыт, но PoC G3 и 20 рандомизированных прогонов ещё не выполнены — гейт остаётся **partial** |
| G1/G2 | Без изменений: PoC-стенды — Phase B |
| PostgreSQL 15 | Phase C, фактический прогон требует Docker/стенда |

---

## 6. Следующий шаг

**Phase B:** исполняемые стенды `poc/g1`, `poc/g2`, `poc/g3` с честной маркировкой `not_run`, CSV-фиксацией и автономностью от продуктовой сборки.
