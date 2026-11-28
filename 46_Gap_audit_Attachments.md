# 46. Gap-audit: скан бумажного наряда

| Параметр | Значение |
|---|---|
| Дата | 28.11.2026 |
| Режим | Демо-пилот: бумажный наряд — оригинал, в системе только скан-копия |
| Решение | Не создавать Permit по фото; не разрабатывать OCR/верификацию/дубли/лимиты по типам |
| Release-статус | FAIL / not approved — не меняется |

## 1. Что уже есть

| Компонент | Состояние |
|---|---|
| `permits` + импорт CSV/JSON | Есть; **оставить как опцию**, в демо не использовать |
| PDF наряда | Серверный PDF/signed URL для старой сущности Permit |
| `EntryPayload.permit_number_raw` | Есть; номер вводится вручную |
| Dexie outbox | Есть операции `entry/shift`; механизм повторных попыток и backoff |
| Object Storage | **Нет**: MinIO/S3 не подключён, PDF в БД не хранится |
| Attachment | **Нет**: таблицы, API, Dexie store |
| S-03 камера/скан | **Нет** |
| S-05 «Документы» | **Нет** |
| Feature flag `attachments` | `false` в `/me` |
| Signed URL | Есть HMAC-подход для PDF/экспорта, можно переиспользовать идею |

## 2. Что нужно добавить

1. `entry_attachments`: `id`, `entry_id` (FK), `kind=permit_scan`, `mime=application/pdf`, `pages 1..10`, `sha256`, `size_bytes <=20MB`, `status local|uploading|uploaded|error`, `object_key`, `created_by`; один активный скан на запись; уникальность `(entry_id, sha256)`.
2. Object Storage (MinIO в Docker) + серверный адаптер; PDF **не** в PostgreSQL.
   В текущем registry образ `minio/minio` недоступен, поэтому пилот использует
   отдельный файловый object-volume (`ATTACHMENTS_DIR`), интерфейс допускает
   замену на S3/MinIO без изменения журнала/метаданных.
3. API:
   - `POST /v1/entries/{id}/attachments` — multipart PDF + `pages`/`sha256`; доступ к записи; идемпотентность по `sha256+entry_id`.
   - `GET /v1/entries/{id}/attachments` — метаданные (для S-05).
   - `GET /v1/entries/{id}/attachments/{attId}` — signed URL ≤15 мин.
   - публичный download по токену, поток из Object Storage.
4. Клиент:
   - Dexie v6 `attachments` с Blob;
   - камера `<input type=file accept=image/* capture=environment multiple>`;
   - сжатие 1600 px / JPEG 0.8, multi-page, превью/удаление/перестановка;
   - сборка PDF через `pdf-lib`;
   - outbox `entity_type=attachment`, `upload_attachment` при появлении сети;
   - лимиты 1 скан/10 стр./20 МБ.
5. UI:
   - S-03: только ручной «Номер наряда» + «Прикрепить скан наряда»;
   - S-05: вкладка «Документы» с пометкой «Копия бумажного наряда. Оригинал хранится на объекте», скачивание.
6. Права: создаёт автор записи/супервизор/админ; просмотр — все с доступом к записи.
7. Тесты: offline create, outbox upload, лимиты, permissions; Docker MinIO; ELEC 2 стр., HOT 8 стр.

## 3. Границы

- Не создавать `Permit` по фото.
- Не удалять существующий импорт Permit.
- Не менять бизнес-логику журнала/синхронизации.
- Не хранить PDF в PostgreSQL.
- Не трогать production-гейты/release-статус.

## 4. Реализация (28.11.2026)

- миграция `0018_entry_attachments.sql`: metadata + unique `(entry_id, sha256)`, один активный скан на запись;
- `AttachmentModule`: multipart upload, list, signed URL (900 с), публичный stream-download;
- PDF в отдельном object-volume (`ATTACHMENTS_DIR`), **не** в PostgreSQL;
- попытка MinIO: образ `minio/minio` в текущем registry недоступен (pull access denied), поэтому демо-драйвер файловый; интерфейс Object Storage изолирован для замены на S3/MinIO;
- Dexie v6 `attachments` (Blob), outbox `entity_type=attachment`, загрузка после sync записи;
- S-03: ручной номер наряда + камера/до 10 страниц/сжатие 1600 px/PDF `pdf-lib`;
- S-05: «Документы», копия бумажного наряда, ссылка на скан;
- тесты: API upload/idempotency/pages/signed URL; web offline scan/outbox;
- production-статус не менялся.

## 5. Ограничение

- файловый object-volume — демо-адаптер; для production нужен S3/MinIO с durable storage, шифрованием и lifecycle.

