# Browser E2E + a11y smoke

Изолированный браузерный прогон Logbook через Edge/Chromium DevTools Protocol.
Playwright не требуется: используется `scripts/e2e/cdp.mjs` и Node built-ins.

## Что проверяется

1. `GET /v1/health` и dev-вход worker.
2. Лента журнала, shell и загрузка справочников.
3. Создание записи через S-03 и карточка S-05.
4. Создание записи в офлайне (CDP `Network.emulateNetworkConditions`), появление в очереди и синхронизация после online.
5. Админ-контур `/admin/users`.
6. PWA service worker: регистрация и активный scope.
7. a11y: axe-core WCAG2 A/AA (login/journal/entry/admin) + базовые проверки `lang=ru`, заголовка, labels, доступных имён, `alt`, landmarks и эвристика контраста (warnings).
8. Отсутствие runtime exceptions в браузере.

`vendor/axe.min.js` — зафиксированная копия axe-core 4.10.2; сеть при прогоне не требуется. Это автоматизированный WCAG-скан, но **не** полноценный manual WCAG/пентест.

## Предварительные условия

- Node.js ≥ 22, собранный web (`npm run build:web`) и API (`npm run build:api`).
- PostgreSQL 15 из `scripts/pg/bootstrap-pg15.ps1`, база с миграциями **0001–0015** (или `E2E_DATABASE_URL`). Для свежей базы: `logbook_e2e_t26` + `npm run db:seed`.
- Edge/Chromium по пути по умолчанию; переопределяется `E2E_BROWSER`.
- Порты 3121 (API), 4173 (web), 9444 (CDP) свободны.

> Для проверки upgrade-пути отдельно нужна БД, созданная на 0014, с последующим `npm run db:migrate` до 0015: текущая 0015 **не backfill-ит `journal_counters`** и push получает duplicate `journal_seq` (B-10 в `38_Релизный_отчёт.md`).

## Запуск

```powershell
npm run test:e2e
# или
node scripts/e2e/run.mjs
```

Результат: `scripts/e2e/results/latest.json`, скриншоты `scripts/e2e/results/e2e-*.png`.
Переменные: `E2E_DATABASE_URL`, `E2E_SSL_CA`, `E2E_API_PORT`, `E2E_WEB_PORT`, `E2E_CDP_PORT`, `E2E_BROWSER`.

## Ограничения

- Linux/Docker/nginx: nginx-конфиг проверяется отдельно (`scripts/security/verify-nginx.ps1`); Docker engine/compose доступны, но full compose требует свободный 5432 и сертификаты; Linux distro/WSL отсутствует — внешний блокер.
- a11y-контраст — эвристика, возможны ложные срабатывания; полноценный axe/manual audit не выполнялся.
- E2E использует dev-провайдер; production OIDC требует реального IdP и отдельного прогона.
