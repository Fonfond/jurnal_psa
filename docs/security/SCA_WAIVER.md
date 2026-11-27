# SCA waiver: оставшиеся moderate-уязвимости dev/build-цепочки

| Параметр | Значение |
|---|---|
| Документ | SCA-WAIVER-2026-11-27 |
| Область | Logbook (ЭОЖ) — `apps/web` build/test toolchain |
| Дата | 27.11.2026 |
| Владелец | security (Security / Infrastructure Engineer) |
| Статус | **Подписан владельцем ИБ**; действует до обновления Workbox/glob/minimatch или до 27.05.2027 |
| Связано | REP-07, AUTH-05, `39_Отчёт_AUTH_Security.md` |

## 1. Что осталось после обновлений

`npm audit` (27.11.2026, production + dev):

```json
{ "info": 0, "low": 0, "moderate": 3, "high": 0, "critical": 0, "total": 3 }
```

| Пакет | Severity | Диапазон | Источник | Где используется |
|---|---|---|---|---|
| `workbox-build` | moderate | >= 7.4.0 | транзитивно от `vite-plugin-pwa` | только генерация service worker при `vite build` |
| `glob` | moderate | 9.0.0 – 14.0.1 | транзитивно от `workbox-build` | обход файлов Workbox при сборке |
| `minimatch` | moderate | 7.0.0 – 11.0.0 | транзитивно от `glob`/`filelist` | сопоставление glob-шаблонов при сборке |

Обновлены и уязвимости устранены:

- `zod` 3.25.76 → **4.6.7** (high: memory exhaustion при валидации коллекций);
- `react-router-dom` 6.30.x → **7.18.7** (moderate: open redirect / SSR hydration);
- `vitest` 3.2.7 → **5.1.2**, `tinypool`/`@vitest/mocker` — устранены critical/moderate
  (`npm audit`: было 10 уязвимостей, включая 2 critical и 1 high);
- `vite-plugin-pwa` 2.0.0 → **1.1.0** (advisory `>=1.2.0`; 1.1.0 поддерживает Vite 7).

Оставшиеся 3 moderate относятся **только к dev/build-зависимостям** и не входят
в production-артефакт: `vite-plugin-pwa`/`workbox-build` не импортируются в
runtime-код SPA и API, а `npm ci --omit=dev` в production-образе их не ставит.

## 2. Почему риск принят (а не «исправлен любой ценой»)

1. `glob`/`minimatch` используются Workbox при генерации precache-manifest по
   **шаблонам из репозитория** (`vite.config.ts`), без пользовательского ввода;
   path traversal/DoS требуют недоверенного glob-шаблона или файловой системы.
2. Уязвимые пакеты не попадают в `apps/web/dist` и не исполняются в браузере,
   API или PostgreSQL; они работают только в CI/сборочном окружении.
3. Принудительный `overrides` на `glob@14`/`minimatch@11` ломает совместимость
   Workbox (проверено: npm помечает зависимости invalid, сборка PWA не
   гарантируется); downgrade `vite-plugin-pwa` ниже 1.1.0 — регресс остальных
   advisory. Обновление будет выполнено, когда Workbox выпустит релиз с
   исправленными транзитивными зависимостями.

## 3. Компенсирующие меры

- Сборка выполняется только из доверенных коммитов CI; артефакты (`dist`,
  `service-worker.js`) фиксируются checksum и публикуются атомарно.
- Production-образ: `npm ci --omit=dev` (devDependencies не устанавливаются),
  многоступенчатая сборка; проверка образа `npm ls --omit=dev` — Workbox
  отсутствует.
- Нет пользовательских/загружаемых glob-шаблонов и нет доступа к произвольным
  путям ФС на этапе сборки; каталоги сборки изолированы.
- `npm audit` запускается в CI и на релизном чек-листе (t15); при появлении
  high/critical в runtime-зависимостях выпуск блокируется.
- Пересмотр waiver: при обновлении `workbox-build`/`vite-plugin-pwa`, но не
  позднее 27.05.2027.

## 4. Подпись

| Роль | Имя/роль | Решение | Дата |
|---|---|---|---|
| Владелец ИБ | security (Security / Infrastructure Engineer) | Принято с компенсациями (пп. 2–3) | 27.11.2026 |
| Release / QA | t15 (по релизному чек-листу) | Учесть waiver в чек-листе; не блокирует выпуск | — |
| ИБ заказчика (при требовании OQ) | — | Требуется отдельное подтверждение для промышленной эксплуатации | — |

Подпись владельца ИБ: **security / 27.11.2026**.
