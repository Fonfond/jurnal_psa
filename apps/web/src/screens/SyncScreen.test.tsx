import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiUser } from '../api/types';
import { createLocalEntry } from '../db/repositories';
import { db } from '../db/schema';
import { SyncScreen } from './SyncScreen';

const user: ApiUser = {
  id: '01930000-0000-7000-8000-000000000101',
  full_name: 'Иван Петров',
  role: 'worker',
  department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок' },
  status: 'active',
  email: 'worker@logbook.local',
};

const input = {
  performed_at: '2026-11-24T08:00:00.000Z',
  performed_tz_offset_min: 480,
  work_type_id: '01930000-0000-7000-8000-000000000302',
  site_id: '01930000-0000-7000-8000-000000000402',
  permit_id: null,
  text: 'Проверил оборудование на участке',
  input_method: 'manual' as const,
};

beforeEach(async () => {
  for (const table of db.tables) {
    await table.clear();
  }
  // The screen calls sync/refresh against the network; keep it offline.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new Error('offline in test')),
  );
});

describe('SyncScreen (S-10)', () => {
  it('renders the outbox queue instead of a white screen', async () => {
    const local = await createLocalEntry(input, user);
    await db.outbox.update(local.last_op_id!, { status: 'dead', attempts: 10 });

    render(
      <MemoryRouter>
        <SyncScreen />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Очередь')).toBeInTheDocument();
    expect(await screen.findByText('Проверил оборудование на участке')).toBeInTheDocument();
    expect(screen.getByText('create')).toBeInTheDocument();
    expect(screen.getByText('Ошибки')).toBeInTheDocument();
    expect(screen.queryByText('Все операции отправлены.')).not.toBeInTheDocument();
  });

  it('shows the empty queue state without operations', async () => {
    render(
      <MemoryRouter>
        <SyncScreen />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Все операции отправлены.')).toBeInTheDocument();
  });
});
