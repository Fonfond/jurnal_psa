import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  DEFAULT_JOURNAL_ID,
  entryPayloadSchema,
  normalizeSiteName,
  type EntryPayload,
  type JournalEventType,
} from '@logbook/shared';
import { ABBREVIATIONS } from '@logbook/shared';
import { db } from '../db/schema';
import { api } from '../api/client';
import {
  clearDraft,
  createLocalEntry,
  getLocalEntry,
  listLocalJournals,
  loadDraft,
  saveDraft,
  updateLocalEntry,
  type EntryInput,
} from '../db/repositories';
import { useAuthStore } from '../stores/auth';
import { useSyncStore } from '../stores/sync';
import { PageHeader, Loader } from '../components/Page';
import {
  PermitScanField,
  type ScanPayload,
} from '../components/PermitScanField';
import {
  createPermitScan,
  listLocalAttachments,
} from '../db/repositories';
import type { AttachmentRow } from '../db/schema';
import {
  fromDateTimeInput,
  timezoneOffsetMinutes,
  toDateTimeInput,
} from '../utils/format';
import { createAsrEngine } from '../asr/engine';

interface SwitchingOperationForm {
  operation: 'open' | 'close' | 'check' | 'measure' | 'other';
  device: string;
  from_state: string;
  to_state: string;
  note: string;
}

interface SwitchingCheckForm {
  check: string;
  passed: boolean;
  note: string;
}

function blankOperation(): SwitchingOperationForm {
  return {
    operation: 'open',
    device: '',
    from_state: '',
    to_state: '',
    note: '',
  };
}

interface FormState {
  journal_id: string;
  performed_at: string;
  time_manual: boolean;
  performed_at_comment: string;
  work_type_id: string;
  site_id: string;
  site_name_raw: string;
  permit_id: string;
  permit_number_raw: string;
  text: string;
  comment: string;
  permit_risk_flag: boolean;
  permit_risk_reason: string;
  accept_server_time: boolean;
  event_type: JournalEventType;
  event_data: Record<string, unknown>;
  switching_operations: SwitchingOperationForm[];
  switching_checks: SwitchingCheckForm[];
  late_entry: boolean;
}

const EMPTY: FormState = {
  journal_id: DEFAULT_JOURNAL_ID,
  performed_at: toDateTimeInput(null),
  time_manual: false,
  performed_at_comment: '',
  work_type_id: '',
  site_id: '',
  site_name_raw: '',
  permit_id: '',
  permit_number_raw: '',
  text: '',
  comment: '',
  permit_risk_flag: false,
  permit_risk_reason: '',
  accept_server_time: false,
  event_type: 'work',
  event_data: {},
  switching_operations: [blankOperation()],
  switching_checks: [],
  late_entry: false,
};

const EVENT_TYPES: Array<[JournalEventType, string]> = [
  ['work', 'Работа'],
  ['command', 'Команда / распоряжение'],
  ['switching', 'Переключение'],
  ['grounding', 'Заземление (З/З, ЗН)'],
  ['incident', 'Инцидент / авария'],
  ['other', 'Другое'],
];

export function EntryEditorScreen(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const [searchParams] = useSearchParams();
  const requestedJournalId = searchParams.get('journal_id');
  const user = useAuthStore((state) => state.user);
  const sync = useSyncStore((state) => state.sync);
  const navigate = useNavigate();
  const initialized = useRef(false);
  const dirty = useRef(false);

  const [form, setForm] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [scanPayload, setScanPayload] = useState<ScanPayload | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanExisting, setScanExisting] = useState<AttachmentRow | undefined>();
  const [siteManual, setSiteManual] = useState(false);
  const scanReady = useCallback(
    (payload: ScanPayload | null) => setScanPayload(payload),
    [],
  );
  const scanBusyChange = useCallback((busy: boolean) => setScanBusy(busy), []);

  const data = useLiveQuery(async () => {
    const [workTypes, sites, permits, journals, entryData, draft] = await Promise.all([
      db.dict_work_types.toArray(),
      db.dict_sites.toArray(),
      db.permits.toArray(),
      listLocalJournals(),
      id ? getLocalEntry(id) : Promise.resolve(null),
      user ? loadDraft(user.id, id ?? null) : Promise.resolve(null),
    ]);
    return { workTypes, sites, permits, journals, entryData, draft };
  }, [id, user?.id]);

  useEffect(() => {
    if (!id) {
      setScanExisting(undefined);
      return;
    }
    void listLocalAttachments(id).then((rows) => setScanExisting(rows[0]));
  }, [id]);

  useEffect(() => {
    if (!id || scanExisting) return;
    void api
      .attachments(id)
      .then(async (response) => {
        if (response.items[0]) {
          await db.attachments.put({
            ...response.items[0],
            created_at_local: response.items[0].created_at,
          } as AttachmentRow);
          setScanExisting(response.items[0] as AttachmentRow);
        }
      })
      .catch(() => undefined);
  }, [id, scanExisting]);

  useEffect(() => {
    if (!data || initialized.current) return;
    initialized.current = true;
    const entry = data.entryData?.entry ?? null;

    if (entry) {
      const entryEventData = (entry.event_data ?? {}) as Record<string, unknown>;
      const operations = Array.isArray(entryEventData.operations)
        ? (entryEventData.operations as Array<Record<string, unknown>>).map(
            (operation) => ({
              operation:
                (operation.operation as SwitchingOperationForm['operation']) ??
                'other',
              device: String(operation.device ?? ''),
              from_state: String(operation.from_state ?? ''),
              to_state: String(operation.to_state ?? ''),
              note: String(operation.note ?? ''),
            }),
          )
        : [];
      const checks = Array.isArray(entryEventData.checks)
        ? (entryEventData.checks as Array<Record<string, unknown>>).map(
            (check) => ({
              check: String(check.check ?? ''),
              passed: Boolean(check.passed),
              note: String(check.note ?? ''),
            }),
          )
        : [];
      setForm({
        journal_id: entry.journal_id ?? DEFAULT_JOURNAL_ID,
        performed_at: toDateTimeInput(entry.performed_at),
        time_manual: entry.performed_at_source === 'manual',
        performed_at_comment: entry.performed_at_comment ?? '',
        work_type_id: entry.work_type_id,
        site_id: entry.site_id ?? '',
        site_name_raw: entry.site_id ? '' : (entry.site_name_raw ?? ''),
        permit_id: '',
        permit_number_raw:
          entry.permit_number_raw ??
          data.permits.find((permit) => permit.id === entry.permit_id)?.number ??
          '',
        text: entry.text,
        comment: entry.comment ?? '',
        permit_risk_flag: entry.permit_risk_flag,
        permit_risk_reason: entry.permit_risk_reason ?? '',
        accept_server_time: false,
        event_type: entry.event_type ?? 'work',
        event_data: entryEventData,
        switching_operations: operations.length > 0 ? operations : [blankOperation()],
        switching_checks: checks,
        late_entry: Boolean(entry.late_entry),
      });
      setSiteManual(!entry.site_id && Boolean(entry.site_name_raw));
      return;
    }

    const firstWorkType = data.workTypes.find((type) => type.active);
    const preferredJournal =
      data.journals.find((journal) => journal.id === requestedJournalId)?.id ??
      data.journals[0]?.id ??
      DEFAULT_JOURNAL_ID;
    const draft = data.draft as Partial<FormState> | null;
    setForm({
      ...EMPTY,
      journal_id: preferredJournal,
      work_type_id: firstWorkType?.id ?? '',
      ...(draft ?? {}),
    });
    const draftSite = draft as Partial<FormState> | null;
    setSiteManual(Boolean(draftSite?.site_name_raw && !draftSite?.site_id));
  }, [data, requestedJournalId]);

  useEffect(() => {
    if (!initialized.current || !dirty.current || !user) return;
    const timer = window.setTimeout(() => {
      void saveDraft(user.id, 'local', form as unknown as Record<string, unknown>, id ?? null)
        .then(() => {
          setDraftSaved(true);
          window.setTimeout(() => setDraftSaved(false), 1500);
        })
        .catch(() => undefined);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [form, id, user]);

  const selectedWorkType = useMemo(
    () => data?.workTypes.find((type) => type.id === form.work_type_id),
    [data?.workTypes, form.work_type_id],
  );
  const serverCorrected =
    data?.entryData?.entry?.performed_at_source === 'server_corrected';
  const asr = useMemo(() => createAsrEngine(), []);

  if (!data) {
    return <Loader label="Готовим форму…" />;
  }

  const update = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    dirty.current = true;
    setForm((current) => ({ ...current, [key]: value }));
  };

  const setEventField = (key: string, value: string | number | null): void => {
    update('event_data', { ...form.event_data, [key]: value });
  };

  const setSwitchingOperation = (
    index: number,
    key: keyof SwitchingOperationForm,
    value: string,
  ): void => {
    update(
      'switching_operations',
      form.switching_operations.map((operation, position) =>
        position === index ? { ...operation, [key]: value } : operation,
      ),
    );
  };

  const addSwitchingOperation = (): void => {
    update('switching_operations', [...form.switching_operations, blankOperation()]);
  };

  const removeSwitchingOperation = (index: number): void => {
    const next = form.switching_operations.filter((_, position) => position !== index);
    update('switching_operations', next.length > 0 ? next : [blankOperation()]);
  };

  const setSwitchingCheck = (
    index: number,
    patch: Partial<SwitchingCheckForm>,
  ): void => {
    update(
      'switching_checks',
      form.switching_checks.map((check, position) =>
        position === index ? { ...check, ...patch } : check,
      ),
    );
  };

  const addSwitchingCheck = (): void => {
    update('switching_checks', [
      ...form.switching_checks,
      { check: '', passed: true, note: '' },
    ]);
  };

  const removeSwitchingCheck = (index: number): void => {
    update(
      'switching_checks',
      form.switching_checks.filter((_, position) => position !== index),
    );
  };

  const buildEventData = (): Record<string, unknown> | null => {
    if (form.event_type === 'work') {
      return null;
    }
    const data: Record<string, unknown> = { ...form.event_data };
    if (form.event_type === 'grounding') {
      data.action = data.action ?? 'applied';
      data.grounding_type = data.grounding_type ?? 'portable';
      data.point = data.point ?? '';
      data.count = data.count ?? 1;
    }
    if (form.event_type === 'switching') {
      const operations = form.switching_operations
        .filter((operation) => operation.device.trim().length > 0)
        .map((operation) => ({
          operation: operation.operation,
          device: operation.device.trim(),
          from_state: operation.from_state.trim() || null,
          to_state: operation.to_state.trim() || null,
          note: operation.note.trim() || null,
        }));
      if (operations.length > 0) {
        data.operations = operations;
      } else {
        delete data.operations;
      }
      const checks = form.switching_checks
        .filter((check) => check.check.trim().length > 0)
        .map((check) => ({
          check: check.check.trim(),
          passed: check.passed,
          note: check.note.trim() || null,
        }));
      if (checks.length > 0) {
        data.checks = checks;
      } else {
        delete data.checks;
      }
    }
    return data;
  };

  const buildPayload = (): Record<string, unknown> => ({
    journal_id: form.journal_id || DEFAULT_JOURNAL_ID,
    performed_at: fromDateTimeInput(form.performed_at),
    performed_tz_offset_min: timezoneOffsetMinutes(),
    performed_at_source: form.time_manual ? 'manual' : 'device_auto',
    performed_at_comment: form.performed_at_comment || null,
    work_type_id: form.work_type_id,
    site_id: form.site_id || null,
    site_name_raw: form.site_id ? null : form.site_name_raw.trim() || null,
    site_binding_status: form.site_id
      ? 'linked'
      : form.site_name_raw.trim()
        ? 'unresolved'
        : 'not_required',
    permit_id: null,
    permit_number_raw: form.permit_number_raw || null,
    permit_binding_status: form.permit_number_raw ? 'unresolved' : 'not_required',
    permit_status_at_sync: null,
    permit_risk_flag: form.permit_risk_flag,
    permit_risk_reason: form.permit_risk_flag
      ? form.permit_risk_reason || null
      : null,
    text: form.text,
    comment: form.comment || null,
    input_method: 'manual',
    offline_created: true,
    accept_server_time: form.accept_server_time,
    event_type: form.event_type,
    event_data: buildEventData(),
    late_entry: form.late_entry,
  });

  const submit = async (): Promise<void> => {
    if (!user) return;
    if (scanBusy) {
      setMessage('Дождитесь сборки PDF скана');
      return;
    }
    setMessage(null);
    const payload = buildPayload();
    const parsed = entryPayloadSchema.safeParse(payload);
    const nextErrors: Record<string, string> = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.') || '_';
        if (!nextErrors[key]) nextErrors[key] = issue.message;
      }
    }
    if (selectedWorkType?.requires_permit && !form.permit_number_raw) {
      nextErrors.permit_number_raw = 'Для этого типа работ нужен номер наряда';
    }
    if (selectedWorkType?.requires_site && !form.site_id && !form.site_name_raw.trim()) {
      nextErrors.site_name_raw = 'Укажите объект или введите его вручную';
    }
    if (form.late_entry && !form.performed_at_comment.trim()) {
      nextErrors.performed_at_comment =
        'Укажите причину поздней записи / корректировки времени';
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setSaving(true);
    try {
      const input = parsed.data as EntryPayload & Record<string, unknown>;
      let entryId: string;
      if (isEdit && id) {
        await updateLocalEntry(id, input as Partial<EntryInput>, user);
        entryId = id;
      } else {
        const created = await createLocalEntry(input as unknown as EntryInput, user);
        await clearDraft(user.id, null);
        entryId = created.id;
      }
      if (scanPayload && !scanExisting) {
        await createPermitScan(
          entryId,
          scanPayload.pdf,
          scanPayload.pages,
          scanPayload.sha256,
          user,
        );
      }
      await clearDraft(user.id, id ?? null);
      void sync();
      navigate(`/entries/${entryId}`, { replace: true });
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="screen">
      <PageHeader
        title={isEdit ? 'Редактирование записи' : 'Новая запись'}
        subtitle="Сохранение на устройстве, отправка — при подключении"
        action={
          <Link to={id ? `/entries/${id}` : '/'} className="button button--ghost">
            Отмена
          </Link>
        }
      />

      {draftSaved ? <div className="draft-hint">Черновик сохранён</div> : null}

      <form
        className="form card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="form-row">
          <label className="field">
            <span>Журнал *</span>
            <select
              value={form.journal_id}
              disabled={isEdit}
              onChange={(event) => update('journal_id', event.target.value)}
              aria-label="Журнал записи"
            >
              {data.journals.map((journal) => (
                <option key={journal.id} value={journal.id}>
                  {journal.name}
                </option>
              ))}
            </select>
            {isEdit ? (
              <small className="hint">
                Журнал записи нельзя изменить после создания.
              </small>
            ) : null}
          </label>
        </div>

        <div className="form-row">
          <label className="field">
            <span>Тип события</span>
            <select
              value={form.event_type}
              onChange={(event) =>
                update('event_type', event.target.value as JournalEventType)
              }
            >
              {EVENT_TYPES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.late_entry}
              onChange={(event) => update('late_entry', event.target.checked)}
            />
            Пропущенная запись
          </label>
        </div>

        {form.event_type === 'command' ? (
          <section className="event-box">
            <label className="field">
              <span>Кто отдал команду *</span>
              <input
                value={String(form.event_data.issued_by ?? '')}
                onChange={(event) => setEventField('issued_by', event.target.value)}
                placeholder="Должность, фамилия"
              />
            </label>
            <label className="field">
              <span>Причина отказа (если был)</span>
              <input
                value={String(form.event_data.refusal_reason ?? '')}
                onChange={(event) =>
                  setEventField('refusal_reason', event.target.value || null)
                }
              />
            </label>
          </section>
        ) : null}

        {form.event_type === 'switching' ? (
          <section className="event-box">
            <div className="form-row">
              <label className="field">
                <span>Номер бланка / распоряжения</span>
                <input
                  value={String(form.event_data.order_no ?? '')}
                  onChange={(event) => setEventField('order_no', event.target.value || null)}
                  aria-label="Номер бланка переключения"
                />
              </label>
              <label className="field">
                <span>Дата распоряжения</span>
                <input
                  type="date"
                  value={String(form.event_data.order_date ?? '')}
                  onChange={(event) =>
                    setEventField('order_date', event.target.value || null)
                  }
                  aria-label="Дата распоряжения"
                />
              </label>
              <label className="field">
                <span>Ответственный</span>
                <input
                  value={String(form.event_data.responsible ?? '')}
                  onChange={(event) =>
                    setEventField('responsible', event.target.value || null)
                  }
                  aria-label="Ответственный за переключение"
                />
              </label>
            </div>
            <label className="field">
              <span>Пункты / оборудование</span>
              <input
                value={String(form.event_data.points ?? '')}
                onChange={(event) => setEventField('points', event.target.value || null)}
                aria-label="Оборудование переключения"
              />
            </label>

            <h3>Последовательность операций</h3>
            {form.switching_operations.map((operation, index) => (
              <div className="form-row" key={`switch-op-${index}`}>
                <label className="field">
                  <span>Операция {index + 1}</span>
                  <select
                    value={operation.operation}
                    aria-label={`Операция ${index + 1}`}
                    onChange={(event) =>
                      setSwitchingOperation(index, 'operation', event.target.value)
                    }
                  >
                    <option value="open">Отключить</option>
                    <option value="close">Включить</option>
                    <option value="check">Проверить</option>
                    <option value="measure">Измерить</option>
                    <option value="other">Другое</option>
                  </select>
                </label>
                <label className="field">
                  <span>Аппарат {index + 1} *</span>
                  <input
                    value={operation.device}
                    aria-label={`Аппарат ${index + 1}`}
                    onChange={(event) =>
                      setSwitchingOperation(index, 'device', event.target.value)
                    }
                    placeholder="Выключатель Q1"
                  />
                </label>
                <label className="field">
                  <span>Из состояния</span>
                  <input
                    value={operation.from_state}
                    aria-label={`Исходное состояние ${index + 1}`}
                    onChange={(event) =>
                      setSwitchingOperation(index, 'from_state', event.target.value)
                    }
                  />
                </label>
                <label className="field">
                  <span>В состояние</span>
                  <input
                    value={operation.to_state}
                    aria-label={`Целевое состояние ${index + 1}`}
                    onChange={(event) =>
                      setSwitchingOperation(index, 'to_state', event.target.value)
                    }
                  />
                </label>
                <button
                  type="button"
                  className="button button--ghost button--small"
                  onClick={() => removeSwitchingOperation(index)}
                >
                  Удалить операцию
                </button>
              </div>
            ))}
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={addSwitchingOperation}
            >
              + Операция
            </button>

            <h3>Проверки</h3>
            {form.switching_checks.map((check, index) => (
              <div className="form-row" key={`switch-check-${index}`}>
                <label className="field">
                  <span>Проверка {index + 1}</span>
                  <input
                    value={check.check}
                    aria-label={`Проверка ${index + 1}`}
                    onChange={(event) =>
                      setSwitchingCheck(index, { check: event.target.value })
                    }
                    placeholder="Проверено отсутствие напряжения"
                  />
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={check.passed}
                    aria-label={`Проверка ${index + 1} пройдена`}
                    onChange={(event) =>
                      setSwitchingCheck(index, { passed: event.target.checked })
                    }
                  />
                  Пройдена
                </label>
                <button
                  type="button"
                  className="button button--ghost button--small"
                  onClick={() => removeSwitchingCheck(index)}
                >
                  Удалить проверку
                </button>
              </div>
            ))}
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={addSwitchingCheck}
            >
              + Проверка
            </button>
            {typeof form.event_data.sequence === 'string' && form.event_data.sequence ? (
              <p className="hint">
                Устаревшая последовательность: {form.event_data.sequence}
              </p>
            ) : null}
          </section>
        ) : null}

        {form.event_type === 'grounding' ? (
          <section className="event-box">
            <div className="form-row">
              <label className="field">
                <span>Действие</span>
                <select
                  value={String(form.event_data.action ?? 'applied')}
                  onChange={(event) => setEventField('action', event.target.value)}
                >
                  <option value="applied">Установлено</option>
                  <option value="removed">Снято</option>
                </select>
              </label>
              <label className="field">
                <span>Тип</span>
                <select
                  value={String(form.event_data.grounding_type ?? 'portable')}
                  onChange={(event) =>
                    setEventField('grounding_type', event.target.value)
                  }
                >
                  <option value="portable">Переносное З/З</option>
                  <option value="fixed">Заземляющие ножи (ЗН)</option>
                </select>
              </label>
            </div>
            <div className="form-row">
              <label className="field">
                <span>Точка установки *</span>
                <input
                  value={String(form.event_data.point ?? '')}
                  onChange={(event) => setEventField('point', event.target.value)}
                  placeholder="Например, КЛ-10 кВ, яч. 5"
                />
              </label>
              <label className="field">
                <span>Номер средства защиты</span>
                <input
                  value={String(form.event_data.tool_number ?? '')}
                  onChange={(event) =>
                    setEventField('tool_number', event.target.value || null)
                  }
                  placeholder="Например, T-1"
                  aria-label="Номер заземления"
                />
              </label>
              <label className="field">
                <span>Количество</span>
                <input
                  type="number"
                  min={0}
                  value={String(form.event_data.count ?? 1)}
                  onChange={(event) =>
                    setEventField(
                      'count',
                      event.target.value === '' ? 0 : Number(event.target.value),
                    )
                  }
                />
              </label>
            </div>
          </section>
        ) : null}

        {form.event_type === 'incident' ? (
          <section className="event-box">
            <div className="form-row">
              <label className="field">
                <span>Тяжесть</span>
                <select
                  value={String(form.event_data.severity ?? 'minor')}
                  onChange={(event) => setEventField('severity', event.target.value)}
                >
                  <option value="minor">Незначительная</option>
                  <option value="major">Серьёзная</option>
                  <option value="critical">Критическая</option>
                </select>
              </label>
              <label className="field">
                <span>Причина</span>
                <input
                  value={String(form.event_data.cause ?? '')}
                  onChange={(event) => setEventField('cause', event.target.value || null)}
                />
              </label>
            </div>
            <label className="field">
              <span>Действия</span>
              <textarea
                rows={2}
                value={String(form.event_data.actions ?? '')}
                onChange={(event) => setEventField('actions', event.target.value || null)}
              />
            </label>
          </section>
        ) : null}

        {form.event_type === 'other' ? (
          <label className="field">
            <span>Описание события</span>
            <textarea
              rows={2}
              value={String(form.event_data.description ?? '')}
              onChange={(event) =>
                setEventField('description', event.target.value || null)
              }
            />
          </label>
        ) : null}

        {errors.event_data ? (
          <div className="alert alert--danger" role="alert">
            {errors.event_data}
          </div>
        ) : null}

        <label className="field">
          <span>Текст записи *</span>
          <textarea
            rows={6}
            value={form.text}
            onChange={(event) => update('text', event.target.value)}
            placeholder="Что выполнено, где, замечания…"
            required
          />
          <span className="field__hint">{form.text.trim().length} / 2000</span>
          {errors.text ? <span className="field__error">{errors.text}</span> : null}
        </label>

        <div className="form-row">
          <label className="field">
            <span>Дата и время *</span>
            <input
              type="datetime-local"
              value={form.performed_at}
              onChange={(event) => update('performed_at', event.target.value)}
              required
            />
            {errors.performed_at ? (
              <span className="field__error">{errors.performed_at}</span>
            ) : null}
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.time_manual}
              onChange={(event) => update('time_manual', event.target.checked)}
            />
            Время указано вручную
          </label>
        </div>

        {serverCorrected ? (
          <div className="alert alert--warning">
            <p>
              Время было скорректировано сервером. Чтобы заменить его своим,
              подтвердите согласие.
            </p>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.accept_server_time}
                onChange={(event) =>
                  update('accept_server_time', event.target.checked)
                }
              />
              Согласен заменить серверное время
            </label>
          </div>
        ) : null}

        {form.late_entry || form.time_manual ? (
          <label className="field">
            <span>
              {form.late_entry
                ? 'Причина поздней записи / корректировки *'
                : 'Причина ручного времени'}
            </span>
            <textarea
              rows={2}
              value={form.performed_at_comment}
              onChange={(event) =>
                update('performed_at_comment', event.target.value)
              }
              placeholder="Например: запись внесена после смены, уточнено по бумажному журналу"
            />
            {errors.performed_at_comment ? (
              <span className="field__error">
                {errors.performed_at_comment}
              </span>
            ) : null}
          </label>
        ) : null}

        <div className="form-row">
          <label className="field">
            <span>Тип работ *</span>
            <select
              value={form.work_type_id}
              onChange={(event) => {
                update('work_type_id', event.target.value);
                const type = data.workTypes.find(
                  (item) => item.id === event.target.value,
                );
                if (!type?.requires_site) update('site_id', '');
                if (!type?.requires_permit) {
                  update('permit_id', '');
                  update('permit_number_raw', '');
                }
              }}
              required
            >
              <option value="">— выберите —</option>
              {data.workTypes
                .filter((type) => type.active)
                .map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
            </select>
            {errors.work_type_id ? (
              <span className="field__error">{errors.work_type_id}</span>
            ) : null}
          </label>

          <div className="field">
            <span>
              Объект {selectedWorkType?.requires_site ? '*' : ''}
            </span>
            {siteManual ? (
              <>
                <div className="field-inline">
                  <input
                    type="text"
                    list="site-suggestions"
                    value={form.site_name_raw}
                    onChange={(event) => {
                      const value = event.target.value;
                      const match = data.sites.find(
                        (site) =>
                          site.active &&
                          normalizeSiteName(site.name) === normalizeSiteName(value),
                      );
                      update('site_name_raw', value);
                      update('site_id', match?.id ?? '');
                    }}
                    placeholder="Начните вводить или выберите из списка"
                    maxLength={120}
                  />
                  <datalist id="site-suggestions">
                    {data.sites
                      .filter((site) => site.active)
                      .map((site) => (
                        <option key={site.id} value={site.name} />
                      ))}
                  </datalist>
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    onClick={() => {
                      setSiteManual(false);
                      update('site_name_raw', '');
                      update('site_id', '');
                    }}
                  >
                    Из справочника
                  </button>
                </div>
                <span className="hint">
                  Можно сохранить, даже если объекта нет в справочнике.
                </span>
              </>
            ) : (
              <div className="field-inline">
                <select
                  value={form.site_id}
                  onChange={(event) => {
                    update('site_id', event.target.value);
                    update('site_name_raw', '');
                  }}
                >
                  <option value="">— не указан —</option>
                  {data.sites
                    .filter((site) => site.active)
                    .map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.name}
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  className="button button--ghost button--small"
                  onClick={() => {
                    const current = data.sites.find((site) => site.id === form.site_id);
                    setSiteManual(true);
                    update('site_id', '');
                    update('site_name_raw', current?.name ?? '');
                  }}
                >
                  Другой объект
                </button>
              </div>
            )}
            {errors.site_name_raw ? (
              <span className="field__error">{errors.site_name_raw}</span>
            ) : null}
            {errors.site_id ? (
              <span className="field__error">{errors.site_id}</span>
            ) : null}
          </div>
        </div>

        <div className="form-row">
          <label className="field">
            <span>
              Номер наряда {selectedWorkType?.requires_permit ? '*' : ''}
            </span>
            <input
              type="text"
              value={form.permit_number_raw}
              onChange={(event) => update('permit_number_raw', event.target.value)}
              placeholder="Например, НД-ЭЛ-001/2026"
            />
            {errors.permit_number_raw ? (
              <span className="field__error">{errors.permit_number_raw}</span>
            ) : null}
          </label>
          <div className="field">
            <span>Скан бумажного наряда</span>
            <PermitScanField
              existing={scanExisting}
              onChange={scanReady}
              onBusy={scanBusyChange}
            />
          </div>
        </div>

        <label className="field">
          <span>Комментарий</span>
          <input
            type="text"
            value={form.comment}
            maxLength={500}
            onChange={(event) => update('comment', event.target.value)}
          />
        </label>

        <div className="risk-box">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.permit_risk_flag}
              onChange={(event) => update('permit_risk_flag', event.target.checked)}
            />
            Работы с повышенным риском / наряд с риском
          </label>
          {form.permit_risk_flag ? (
            <label className="field">
              <span>Причина риска *</span>
              <input
                type="text"
                value={form.permit_risk_reason}
                onChange={(event) => update('permit_risk_reason', event.target.value)}
              />
              {errors.permit_risk_reason ? (
                <span className="field__error">{errors.permit_risk_reason}</span>
              ) : null}
            </label>
          ) : null}
        </div>

        <div className="voice-row">
          <button
            type="button"
            className="button button--ghost"
            disabled={!asr.available}
            title="TODO(G1): on-device ASR; TODO(OQ-10): Web Speech"
          >
            🎙 Голосовой ввод
          </button>
          <span className="hint">
            Ручной режим по умолчанию. ASR выключен до G1.
          </span>
        </div>

        {message ? (
          <div className="alert alert--danger" role="alert">
            {message}
          </div>
        ) : null}

        <details className="abbr">
          <summary>Допускаемые сокращения (подсказка)</summary>
          <p className="hint">
            Приложение 2 к письму 42-6/35-ЭТ. Приложение не заменяет текст
            автоматически.
          </p>
          <ul className="abbr__list">
            {ABBREVIATIONS.slice(0, 30).map((item) => (
              <li key={`${item.short}-${item.full}`}>
                <strong>{item.short}</strong> — {item.full}
              </li>
            ))}
          </ul>
        </details>

        <button type="submit" className="button button--primary" disabled={saving}>
          {saving ? 'Сохраняем…' : isEdit ? 'Сохранить изменения' : 'Сохранить запись'}
        </button>
      </form>
    </div>
  );
}
