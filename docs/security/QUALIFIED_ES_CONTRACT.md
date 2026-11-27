# Контракт qualified ЭП (КЭП-адаптер) — версия 1

| Параметр | Значение |
|---|---|
| Документ | QUALIFIED-ES-CONTRACT v1 |
| Область | `apps/api/src/signature/qualified.provider.ts` ↔ внешний сервис КЭП/УЦ |
| Статус | Контракт проверен тестовым провайдером; **реальный КЭП не подключён** (OQ-04, внешние credentials) |
| Связано | OQ-04, REP-01, `39_Отчёт_AUTH_Security.md`, `docs/security/REP-01_02_WAIVER.md` |

## 1. Назначение

Logbook не хранит закрытые ключи и сертификаты подписи. `qualified`-адаптер
передаёт канонический `content_hash` во внешний сервис КЭП, получает CMS-подпись
и метаданные сертификата, сохраняет их в `document_signatures`. Проверка
подписи также делегируется сервису КЭП.

## 2. Транспорт

- `POST <SIGNATURE_QUALIFIED_ENDPOINT>` (HTTPS в production).
- `Authorization: Bearer <SIGNATURE_QUALIFIED_TOKEN>`.
- `Content-Type: application/json; charset=utf-8`, `Accept: application/json`.
- Таймаут: `SIGNATURE_QUALIFIED_TIMEOUT_MS` (500–30000 мс, по умолчанию 5000).
- Один endpoint обслуживает обе операции; операция — поле `operation`.

## 3. Sign

```json
{
  "operation": "sign",
  "entity_type": "entry" | "journal_review",
  "entity_id": "<uuid>",
  "entity_version": 1,
  "content_hash": "<sha256 hex, 64>",
  "signer_id": "<uuid>"
}
```

Успешный ответ `200`:

```json
{
  "signature": "<base64 CMS/PKCS#7>",
  "algorithm": "CMS-BES",
  "key_id": "uc-key-1",
  "certificate_serial": "0A1B2C3D",
  "certificate_subject": "CN=..., O=..., ИНН=...",
  "metadata": { "provider": "cryptopro", "ts": "2026-11-27T00:00:00Z" }
}
```

Обязательно: непустой `signature`. `algorithm` по умолчанию `CMS-BES`;
`key_id`/`certificate_*` сохраняются в записи подписи, если переданы.

## 4. Verify

```json
{
  "operation": "verify",
  "entity_type": "entry",
  "entity_id": "<uuid>",
  "entity_version": 1,
  "content_hash": "<sha256 hex>",
  "signer_id": "<uuid>",
  "signature": "<base64 CMS>",
  "algorithm": "CMS-BES"
}
```

Успешный ответ `200`:

```json
{ "valid": true }
// или
{ "valid": false, "reason": "content_hash_or_signature_mismatch" }
```

`valid` обязателен и должен быть boolean. `false` переводит подпись в
`document_signatures.status='invalid'` и аудитируется.

## 5. Ошибки и таймауты (fail-closed)

| Условие | Поведение адаптера | Код API |
|---|---|---|
| Сеть/таймаут/abort | `SignatureProviderError("Сервис КЭП недоступен: ...")` | `E-SIG-02` (501) |
| HTTP ≠ 2xx | `SignatureProviderError("Сервис КЭП вернул HTTP <status>: ...")` | `E-SIG-02` |
| Невалидный JSON | `SignatureProviderError("...некорректный JSON")` | `E-SIG-02` |
| Нет `signature` в sign | `SignatureProviderError("Сервис КЭП не вернул подпись")` | `E-SIG-02` |
| Нет `valid` в verify | `SignatureProviderError("...не вернул результат проверки")` | `E-SIG-02` |
| Провайдер не настроен (`none`/нет endpoint/token) | `E-SIG-02` до вызова | `E-SIG-02` |

Никаких «успешных» подписей при недоступном сервисе не создаётся; авто-подпись
для `qualified` **не выполняется внутри БД-транзакции** (только ручной
`POST /entries/:id/sign`, `POST /journal/reviews/:id/sign`).

## 6. Тестовый провайдер (не production)

`apps/api/test/helpers/qualified-esp-test-provider.ts` — HTTP-сервер,
реализующий §3–5, с режимами: успех, tamper (`valid=false`), HTTP 503,
невалидный JSON, задержка (таймаут). Тесты:
`apps/api/test/qualified-signature.spec.ts` (5 тестов: контракт sign/verify,
tamper, HTTP-ошибка, JSON, timeout; интеграция API — ручная подпись, verify,
подмена, `E-SIG-02` при недоступном сервисе).

Тестовый провайдер **не является КЭП**, не проверяет реальные сертификаты и
никогда не должен включаться в production. Production требует:
аккредитованный УЦ/КЭП, выпущенные сертификаты, договор и юридическое решение
OQ-04; до этого `SIGNATURE_PROVIDER=qualified` в production не выдаётся за
рабочую КЭП.

## 7. Совместимость и ограничения

- Сервис КЭП должен поддерживать идемпотентность по `(entity_type, entity_id,
  entity_version, content_hash)`: Logbook сохраняет одну подпись на версию.
- Ротация ключей/сертификатов УЦ — на стороне провайдера; `key_id` сохраняется
  для аудита, старые подписи не пересоздаются.
- Формат CMS не парсится Logbook; проверка — только через сервис КЭП
  (компромисс до появления локального криптопровайдера).
- Реальный контракт должен быть подтверждён интеграционным тестом с выбранным
  провайдером; тестовый провайдер покрывает транспорт/ошибки/таймауты.
