# 34. Отчёт: админ-контур (ADR-14, ADM-01/ADM-02/ADM-04)

| Параметр | Значение |
|---|---|
| Версия | 1.0 |
| Дата | 25.11.2026 |
| Автор | Frontend / PWA Engineer |
| Задача | t8 `[admin-ui]` — экраны пользователей, ролей, журналов, устройств, импорта нарядов, хранения и аудита; отдельный origin (ADR-14); тесты |
| Основание | t2 (роли/устройства/ЭП), t3 (журналы/гранты), t6 (импорт и PDF нарядов), t7 (retention/архив/WORM-экспорт) |
| Статус | Реализовано и проверено; остаются OQ-05/OQ-18 (сроки хранения), OQ-03 (владелец нарядов), OQ-07 (админка справочников) |

---

## 1. Итог

Появился полноценный административный контур на **отдельном origin** (ADR-14) — тот же production-бандл, но с собственной оболочкой `/admin/*`, доступной только роли `admin` (guard в UI + `@Roles('admin')` на API):

1. **Обзор** — пользователи/активные, устройства, журналы, состояние хранения, последние экспорты и действия аудита.
2. **Пользователи** — поиск/фильтры (роль, статус), создание, изменение роли/статуса/подразделения/должности, завершение всех сессий; всё аудируется (`user.create/update/revoke_sessions`).
3. **Роли** — счётчики по ролям и матрица возможностей (worker/supervisor/admin/auditor).
4. **Журналы** — каталог, создание, включение/выключение, гранты пользователям (`read/write/manage`) и их отзыв.
5. **Устройства** — полный инвентарь по пользователям, поиск/статус, отзыв устройства с завершением привязанных сессий.
6. **Импорт нарядов** — CSV/JSON через серверный адаптер, результат (создано/обновлено/ошибки строк) и история импортов из аудита.
7. **Хранение** — политика `RETENTION_YEARS` (read-only, OQ-05/OQ-18), cutoff, объём записей, запуск retention-проверки, проверка hash-цепочки аудита, backup manifest/checkpoint, WORM-архив журнала и список архивов (t7).
8. **Экспорт** — WORM-экспорты журнала (PDF 3 графы + CSV), фильтры, подписанные короткоживущие ссылки на PDF/CSV (t7).
9. **Аудит** — фильтры по действию/объекту/периоду/лимиту, просмотр before/after и hash.

### API, добавленное для админки (без пересечения с t7)

| Endpoint | Назначение |
|---|---|
| `GET /v1/admin/users` | Каталог пользователей: `search`, `role`, `status`, `department_id`, `limit`, `offset` → `{items, total}` |
| `POST/PATCH /v1/admin/users[...]` | Существующие create/patch/revoke-sessions (ADM-01/ADM-02) |
| `GET /v1/admin/departments` | Подразделения для форм пользователя/журнала |
| `GET /v1/admin/devices` | Все устройства всех пользователей: `search`, `status`, `limit`, `offset` → `{items, total}` |
| `DELETE /v1/admin/devices/{id}` | Отзыв любого устройства (владелец — через `/devices/{id}`) |
| `GET /v1/me` → `csrf_token` | Токен для отдельного admin origin (cookie API-origin не читается) |
| `ADMIN_ORIGIN` (env) | CORS для admin-origin и production-валидация (https, не равен основному origin) |

Retention/архив/экспорт — контракт t7 (`/v1/admin/retention*`, `/v1/admin/audit/verify`, `/v1/admin/backup/*`, `/v1/admin/exports*`); админ-UI использует его как есть, отдельного `retention_policies` в БД нет (политика задаётся `RETENTION_YEARS`, сроки не утверждены).

### ADR-14: отдельный origin

* Один production-бандл; на admin-домене (`VITE_ADMIN_ORIGIN=https://admin.example.com`) маршрут `/` редиректит на `/admin`, а API разрешает этот origin в CORS (`ADMIN_ORIGIN`).
* Cookies host-only и `SameSite=Lax`: админ-сессия живёт в cookie-jar админ-домена и не пересекается с операционной сессией; API дополнительно возвращает CSRF-токен в `/v1/me`, потому что cookie API-домена недоступна JS на другом origin.
* Production-валидация env: `ADMIN_ORIGIN` обязан быть https и не может совпадать с `CORS_ORIGIN`.
* Инфраструктура (DNS/сертификат) остаётся внешней зависимостью ADR-14; при её отсутствии тот же контур доступен по `/admin` на основном origin (guard по роли сохраняется).

---

## 2. Изменения по файлам

| Файл | Изменение |
|---|---|
| `apps/web/src/components/AdminLayout.tsx` (новый) | Оболочка админки: шапка, «К журналу», выход, 9 разделов |
| `apps/web/src/screens/admin/*` (новые) | `AdminOverviewScreen`, `AdminUsersScreen`, `AdminRolesScreen`, `AdminJournalsScreen`, `AdminDevicesScreen`, `AdminImportsScreen`, `AdminRetentionScreen`, `AdminExportsScreen`, `AdminAuditScreen`, barrel `index.ts` |
| `apps/web/src/app/App.tsx` | `RequireAdmin` guard, `/admin/*` маршруты, редирект admin-origin на `/admin` |
| `apps/web/src/components/Layout.tsx` | Пункт «Админка» для роли admin |
| `apps/web/src/config/admin.ts` (новый) | `ADMIN_ORIGIN`, `isAdminOrigin`, базовая логика отдельного origin |
| `apps/web/src/api/client.ts`, `api/types.ts` | Admin API: users/departments/devices/audit, retention/archives/verify/backup, exports, journals/grants, imports; типы admin-сущностей; `/me.csrf_token` сохраняется в памяти |
| `apps/web/src/vite-env.d.ts`, `styles.css` | `VITE_ADMIN_ORIGIN`, стили admin-shell/table/nav |
| `apps/api/src/admin/admin.controller.ts`, `admin.service.ts` | `GET admin/users`, `GET admin/departments`; контроллер переведён на базу `/v1/admin` без изменения существующих путей |
| `apps/api/src/devices/devices.controller.ts`, `devices.service.ts` | `GET admin/devices`, `DELETE admin/devices/:id`, `listAll` с join пользователей (колонки квалифицированы) |
| `apps/api/src/auth/auth.controller.ts` | `csrf_token` в `/v1/me` (ADR-14) |
| `apps/api/src/config/env.ts`, `common/configure-app.ts` | `ADMIN_ORIGIN`, CORS из двух origin, production-валидация |
| `apps/api/test/admin-ui.spec.ts` (новый) | 8 тестов админ-контура |
| `apps/api/test/db.spec.ts` | Ожидание миграций `0001…0012` (включая `0012_retention_export.sql` t7) |

---

## 3. Тесты

| Файл | Покрытие |
|---|---|
| `apps/api/test/admin-ui.spec.ts` (8) | список пользователей с фильтрами и 403 для worker/supervisor; создание/патч роли и статуса/revoke-sessions; подразделения; инвентарь устройств, отзыв администратором, 403 worker; журналы/гранты/снятие/выключение; история импорта; `csrf_token` в `/me` и CORS-preflight admin-origin; hash-цепочка аудита |
| `apps/web/src/screens/admin/AdminUsersScreen.test.tsx` (4) | список и фильтры, создание, смена статуса и завершение сессий, ошибка загрузки |
| `apps/web/src/screens/admin/AdminOpsScreens.test.tsx` (7) | устройства + отзыв; импорт CSV + ошибки + история; хранение (политика, проверка, аудит, архив) и честный 404; WORM-экспорт + подписанная ссылка; аудит с фильтром; журналы + грант |
| `apps/web/src/screens/admin/AdminAccess.test.tsx` (2) | worker получает отказ, admin видит оболочку и пункты меню |

Проверки: `npm run typecheck` (shared/API/web+SW) — exit 0; `npm test` — **238 тестов** (28 shared / 88 API в 14 suites / 122 web в 26 файлах), включая 8 API-тестов админ-контура и 13 web-тестов S-16+; `npm run build` — успешно (527,01 КБ JS / 151,64 КБ gzip, precache 11 файлов / 542,95 КиБ, `dist/service-worker.js` 8,5 КБ).

---

## 4. Ограничения и открытые вопросы

| ID | Ограничение | Статус |
|---|---|---|
| OQ-05/OQ-18 | Сроки хранения (3 года) не утверждены заказчиком/юристом | Политика read-only из `RETENTION_YEARS`, UI явно предупреждает |
| OQ-03 | Источник нарядов и допустимость локального импорта не подтверждены владельцем | Импорт CSV/JSON — admin fallback, UI помечает ручной режим |
| OQ-07 | Владелец справочников и админки не зафиксирован | Экраны справочников не входят в t8; API `PATCH /admin/dictionaries/:name` существует |
| ADR-14 | DNS/сертификат admin-поддомена — инфраструктура | Код и конфигурация готовы; без поддомена доступен `/admin` |
| AUTH-05 | CSP/HSTS/security headers для отдельного origin | Не входит в t8 (security-трек) |
| ADM-03 | Массовые операции/выгрузки пользователей | Только одиночные действия + аудит; экспорт пользовательских данных — отдельная задача |

Сознательные упрощения: админ-UI не работает офлайн (директория и аудит — серверные данные); удаление пользователей не реализовано — только деактивация/блокировка (OQ-18: правила владения данными); гранты журналов — только явные (`journal_members`), ролевая видимость не дублируется в UI.
