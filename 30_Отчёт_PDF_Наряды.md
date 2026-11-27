# Отчёт 30. PDF и интеграция нарядов (OQ-03, PRM-01, t6)

| Параметр | Значение |
|---|---|
| Дата | 25.11.2026 |
| Задача | t6 [permits-integration] |
| Статус | Выполнено; OQ-03 требует подтверждения источника/владельца нарядов |
| Миграция | `0011_permit_pdf.sql` |
| Проверка | `npm test` — 28 shared / 74 API / 109 web = **211 pass**; typecheck 0; build ok |

## 1. PDF наряда

Сервер формирует одностраничный PDF карточки наряда без внешних библиотек:
встроенный UTF-8 шрифт Open Sans (Apache-2.0) как `CIDFontType2`/`Identity-H`,
русский текст, поля наряда (номер, период, объект, ответственный, работы,
источник, deep link), дата формирования. `pdf_generated_at` фиксируется в БД и
входит в документ, поэтому hash и размер воспроизводимы; `pdf_hash`/`pdf_size_bytes`
обновляются в `permits`.

Шрифт лежит в `apps/api/assets/OpenSans-Regular.ttf`; путь резолвится и из `src/`,
и из `dist/` (при упаковке API каталог `assets` должен попадать рядом с `dist`).

## 2. Signed URL (≤15 мин)

`POST /v1/permits/{id}/pdf-url` выпускает HMAC-подписанную ссылку
`/v1/permits/pdf/{id}?token=...`; токен содержит permit id, срок, версию и
источник (`generated`/`external`). Секрет — `PERMIT_PDF_SECRET`, fallback
`COOKIE_SECRET`; TTL — `PERMIT_PDF_TTL_SECONDS` (60–900). `GET` требует сессию,
проверяет подпись, срок и версию наряда: подмена/просрочка → 403, изменение наряда
после выдачи → 400 `E-VAL-01`, без сессии → 401. Для внешнего PDF отдаётся 302 на
`pdf_url` источника (deep link), иначе — `application/pdf` с `Content-Disposition`
и `X-Content-SHA256`. Оба действия аудируются: `permit.pdf_url`,
`permit.pdf_download`.

## 3. Адаптер источника и импорт

`PermitSourceAdapter` (CSV/JSON) нормализует записи, включая `external_url`
(deep link), `pdf_url`, `pdf_hash`. Импорт `POST /v1/admin/permits/import`:

- CSV (legacy) — `{source_id, csv}`;
- JSON-фид источника — `{source_id, records: [...]}`;
- идемпотентность по `(source_id, external_id)`: повтор → `updated`, ошибки строк
  не прерывают импорт и возвращаются в `errors[]`;
- аудит `permit.import` содержит `source_id`, `adapter`, `format`, счётчики;
- наряд с `pdf_url` получает `pdf_source='external'`, `pdf_hash` источника.

## 4. UI

S-07 «Наряды»: метки PDF/deep link в списке; карточка наряда показывает deep link,
кнопку «PDF наряда» (signed URL), «PDF источника» при внешнем PDF, hash/размер/срок
ссылки; ошибки отображаются пользователю.

## 5. Проверки

- `apps/api/test/permits-pdf.spec.ts` (4): генерация и детерминированность,
  скачивание по signed URL, hash/headers, аудит; tamper/expired/чужой permit/версия/
  без сессии; внешний redirect 302; JSON-импорт дважды, invalid row, deep links,
  PDF источника.
- `apps/api/test/api.e2e.spec.ts`: CSV-импорт идемпотентен, PDF-ссылка выдаётся.
- `apps/api/test/db.spec.ts`: миграции 0001–0011.
- `apps/web/src/screens/PermitsScreen.test.tsx` (3): generated/external PDF, список.
- typecheck (app+SW) — 0 ошибок, `npm run build` — успешно.

## 6. Ограничения

- OQ-03 не закрыт юридически: какой источник нарядов использовать (API/CSV),
  допустима ли локальная генерация PDF и нужен ли внешний signed URL — решает
  владелец нарядов.
- Расписание/пуш синхронизации нарядов, webhook источника и очередь импорта не
  реализованы (ручной admin-импорт остаётся fallback).
- PDF журнала (JRN-07) и подписанный экспорт журнала — отдельная работа.
