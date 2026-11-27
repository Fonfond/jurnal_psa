export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

export function toDateTimeInput(iso: string | null | undefined): string {
  if (!iso) {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

export function fromDateTimeInput(value: string): string {
  return new Date(value).toISOString();
}

export function timezoneOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

export function roleLabel(role: string | undefined): string {
  switch (role) {
    case 'worker':
      return 'Сотрудник';
    case 'supervisor':
      return 'Руководитель';
    case 'admin':
      return 'Администратор';
    case 'auditor':
      return 'Аудитор';
    default:
      return role ?? '—';
  }
}

export function syncStatusLabel(status: string | undefined): string {
  switch (status) {
    case 'pending':
      return 'Ожидает отправки';
    case 'syncing':
      return 'Отправляется';
    case 'conflict':
      return 'Конфликт';
    case 'error':
      return 'Ошибка';
    default:
      return 'Синхронизировано';
  }
}
