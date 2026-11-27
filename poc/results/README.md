# `poc/results/` — сырые данные PoC

| Параметр | Значение |
|---|---|
| Назначение | Хранение сырых замеров для отчёта и повторной проверки |
| Формат | UTF-8 CSV, разделитель `,`, точка как десятичный разделитель |
| Заполнение | Вручную или скриптами из `poc/tools/` |
| Правило | Пустых значений нет: `n/a` для неприменимых полей |

---

## 1. Файлы

| Файл | Кто заполняет | Когда |
|---|---|---|
| `devices.csv` | QA | D1 |
| `artifacts.csv` | QA | D1 |
| `g1_measurements.csv` | Frontend + QA | D2–D3 |
| `g2_measurements.csv` | Frontend + QA | D4–D5 |
| `g3_runs.csv` | Backend + QA | D6–D8 |

---

## 2. Словарь колонок

### 2.1. `g1_measurements.csv`

| Колонка | Тип | Допустимые значения / правило |
|---|---|---|
| `run_id` | string | `G1-0001`… |
| `date_utc` | ISO 8601 | `2026-11-24T08:15:00Z` |
| `device_id` | string | D1…D7 |
| `device_class` | enum | `A`, `B`, `C`, `n/a` (iOS) |
| `os` | string | `Android 12`, `iOS 16.4` |
| `browser` | string | `Chrome`, `Safari`, `Edge` |
| `browser_version` | string | Точная версия |
| `model_id` | string | Идентификатор модели |
| `model_size_mb` | number | ≤ 40 |
| `scenario` | string | `POC-G1-01`…`12` |
| `audio_file` | string | Имя файла корпуса |
| `audio_duration_s` | number | — |
| `latency_s` | number | Время распознавания |
| `rtf` | number | `latency_s / audio_duration_s` |
| `peak_mem_mb` | number | Пиковая память |
| `wer` | number | 0…1; `n/a` если не применимо |
| `crashed` | bool | `true/false` |
| `notes` | string | Факты: температура, аномалии |

### 2.2. `g2_measurements.csv`

| Колонка | Тип | Правило |
|---|---|---|
| `run_id` | string | `G2-0001`… |
| `date_utc` | ISO 8601 | — |
| `device_id` | string | D1…D7 |
| `os` | string | — |
| `browser` | string | — |
| `scenario` | string | `POC-G2-01`…`12` |
| `records` | int | Число записей в базе |
| `ops` | int | Число операций в очереди |
| `quota_mb` | number | Оценка квоты |
| `persist_granted` | bool | Результат `persisted()` |
| `atomic_ok` | bool | Транзакция без частичных состояний |
| `data_loss` | bool | Потеря данных |
| `export_ok` | bool | Экспорт полный |
| `restore_ok` | bool | Восстановление полное |
| `migration_ok` | bool | Миграция успешна |
| `duration_ms` | number | Длительность операции |
| `notes` | string | — |

### 2.3. `g3_runs.csv`

| Колонка | Тип | Правило |
|---|---|---|
| `run_id` | string | `G3-0001`… |
| `date_utc` | ISO 8601 | — |
| `scenario_id` | string | `POC-G3-01`…`24` |
| `conflict_id` | string | `C-01`…`C-12` или `n/a` |
| `ops_count` | int | Число операций |
| `repeats` | int | Повторы |
| `delivery_order` | string | `base`, `reverse`, `random`, `delayed` |
| `expected` | string | Ожидаемый результат |
| `actual` | string | Фактический результат |
| `data_loss` | bool | Потеря данных |
| `deterministic` | bool | Совпадение с эталоном |
| `latency_ms` | number | Длительность |
| `notes` | string | — |

---

## 3. Правила прогонов

1. Перед серией — очистка данных сайта и перезапуск браузера.
2. Каждый замер — 5 прогонов; в CSV — все 5 строк, агрегаты считаются в отчёте.
3. Аномалии помечаются в `notes` и не удаляются.
4. Сырые данные не редактируются после подписания отчёта; исправления — отдельным файлом с суффиксом `_fix`.
5. Файлы результатов не попадают в продуктовый репозиторий.
