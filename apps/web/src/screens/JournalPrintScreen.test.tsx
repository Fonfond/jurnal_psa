import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiUser } from '../api/types';
import { createLocalEntry } from '../db/repositories';
import { db } from '../db/schema';
import { JournalPrintScreen } from './JournalPrintScreen';

const user: ApiUser = {
  id: '01930000-0000-7000-8000-000000000101',
  full_name: 'Иван Петров',
  role: 'worker',
  department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок' },
  status: 'active',
  email: 'worker@logbook.local',
};

beforeEach(async () => {
  for (const table of db.tables) {
    await table.clear();
  }
  await createLocalEntry(
    {
      performed_at: '2026-11-24T08:00:00.000Z',
      performed_tz_offset_min: 480,
      work_type_id: '01930000-0000-7000-8000-000000000302',
      site_id: '01930000-0000-7000-8000-000000000402',
      permit_id: null,
      text: 'Запись для печатной формы журнала',
      input_method: 'manual',
      event_type: 'work',
    },
    user,
  );
});

describe('JournalPrintScreen', () => {
  it('renders the three-column operational journal form', async () => {
    render(<JournalPrintScreen />);

    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Дата, время')).toBeInTheDocument();
    expect(
      screen.getByText('Содержание сообщений в течение смены'),
    ).toBeInTheDocument();
    expect(screen.getByText('Визы, замечания')).toBeInTheDocument();
    expect(
      screen.getByText('Запись для печатной формы журнала'),
    ).toBeInTheDocument();
    expect(screen.getByText(/не подписаны ЭП/)).toBeInTheDocument();
  });
});
