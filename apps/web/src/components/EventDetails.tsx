import type { GroundingEventData, SwitchingEventData } from '@logbook/shared';

const OPERATION_LABELS: Record<string, string> = {
  open: 'Отключить',
  close: 'Включить',
  check: 'Проверить',
  measure: 'Измерить',
  other: 'Операция',
};

/**
 * Structured operational event rendering (757 switching form, grounding).
 * Shared by the entry card, print form and the offline journal.
 */
export function EventDetails({
  eventType,
  data,
}: {
  eventType: string | undefined;
  data: unknown;
}): JSX.Element | null {
  if (!data) {
    return null;
  }
  const record = data as Record<string, unknown>;

  if (eventType === 'switching') {
    const switching = record as unknown as SwitchingEventData;
    const operations = switching.operations ?? [];
    const checks = switching.checks ?? [];
    return (
      <div className="event-box">
        <dl className="detail-grid">
          {switching.order_no ? (
            <div>
              <dt>Бланк / распоряжение</dt>
              <dd>{switching.order_no}</dd>
            </div>
          ) : null}
          {switching.order_date ? (
            <div>
              <dt>Дата распоряжения</dt>
              <dd>{switching.order_date}</dd>
            </div>
          ) : null}
          {switching.responsible ? (
            <div>
              <dt>Ответственный</dt>
              <dd>{switching.responsible}</dd>
            </div>
          ) : null}
          {switching.points ? (
            <div>
              <dt>Оборудование</dt>
              <dd>{switching.points}</dd>
            </div>
          ) : null}
        </dl>

        {operations.length > 0 ? (
          <ol aria-label="Последовательность операций">
            {operations.map((operation, index) => (
              <li key={`${operation.device}-${index}`}>
                <strong>{OPERATION_LABELS[operation.operation] ?? operation.operation}</strong>{' '}
                — {operation.device}
                {operation.from_state || operation.to_state
                  ? `: ${operation.from_state ?? '—'} → ${operation.to_state ?? '—'}`
                  : ''}
                {operation.note ? ` (${operation.note})` : ''}
              </li>
            ))}
          </ol>
        ) : typeof switching.sequence === 'string' && switching.sequence ? (
          <p>Последовательность: {switching.sequence}</p>
        ) : null}

        {checks.length > 0 ? (
          <ul aria-label="Проверки при переключении">
            {checks.map((check, index) => (
              <li key={`${check.check}-${index}`}>
                {check.passed ? '✓' : '✗'} {check.check}
                {check.note ? ` — ${check.note}` : ''}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  if (eventType === 'grounding') {
    const grounding = record as unknown as GroundingEventData;
    return (
      <div className="event-box">
        <dl className="detail-grid">
          <div>
            <dt>Действие</dt>
            <dd>{grounding.action === 'applied' ? 'Установлено' : 'Снято'}</dd>
          </div>
          <div>
            <dt>Тип</dt>
            <dd>
              {grounding.grounding_type === 'portable'
                ? 'Переносное З/З'
                : 'Заземляющие ножи (ЗН)'}
            </dd>
          </div>
          <div>
            <dt>Точка</dt>
            <dd>{grounding.point}</dd>
          </div>
          <div>
            <dt>Номер / количество</dt>
            <dd>
              {grounding.tool_number ?? '—'} · {grounding.count ?? 1}
            </dd>
          </div>
        </dl>
      </div>
    );
  }

  return null;
}
