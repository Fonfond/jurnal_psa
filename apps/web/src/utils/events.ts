import type { JournalEventType, ShiftStatus } from '@logbook/shared';

/** Human labels for operational event types (S-02, S-05, S-14, print). */
export const EVENT_TYPE_LABELS: Record<JournalEventType, string> = {
  work: 'Работа',
  command: 'Команда',
  switching: 'Переключение',
  grounding: 'Заземление',
  incident: 'Инцидент',
  other: 'Другое',
};

export type EventTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export function eventTypeLabel(
  type: JournalEventType | null | undefined,
): string {
  return EVENT_TYPE_LABELS[type ?? 'work'] ?? 'Событие';
}

export function eventTypeTone(
  type: JournalEventType | null | undefined,
): EventTone {
  switch (type) {
    case 'switching':
      return 'info';
    case 'grounding':
      return 'warning';
    case 'incident':
      return 'danger';
    case 'command':
      return 'success';
    default:
      return 'neutral';
  }
}

/** Operational events that have their own registry screens / structured data. */
export function isOperationalEvent(
  type: JournalEventType | null | undefined,
): boolean {
  return type === 'switching' || type === 'grounding';
}

/** Route to the journal filtered by an operational event type. */
export function journalFilterHref(
  eventType: JournalEventType,
  journalId?: string | null,
): string {
  const params = new URLSearchParams({ event_type: eventType });
  if (journalId) {
    params.set('journal_id', journalId);
  }
  return `/?${params.toString()}`;
}

export const SHIFT_STATUS_LABELS: Record<ShiftStatus, string> = {
  handed_over: 'Сдана, ожидает приёмки',
  accepted: 'Принята',
  rejected: 'Отклонена',
  cancelled: 'Отменена',
};

export function shiftStatusLabel(status: ShiftStatus): string {
  return SHIFT_STATUS_LABELS[status] ?? status;
}

export type ShiftTone = 'success' | 'warning' | 'danger' | 'neutral';

export function shiftStatusTone(status: ShiftStatus): ShiftTone {
  switch (status) {
    case 'handed_over':
      return 'warning';
    case 'accepted':
      return 'success';
    case 'rejected':
      return 'danger';
    default:
      return 'neutral';
  }
}

