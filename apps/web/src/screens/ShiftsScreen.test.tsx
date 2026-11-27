import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_JOURNAL_ID } from '@logbook/shared';
import type { ApiUser } from '../api/types';
import { createShiftLocal, getLocalShift } from '../db/shift-repositories';
import { db } from '../db/schema';
import { useAuthStore } from '../stores/auth';
import { useSyncStore } from '../stores/sync';
import { ShiftsScreen } from './ShiftsScreen';

const outgoing: ApiUser = {
  id: '01930000-0000-7000-8000-000000000102',
  full_name: 'Петров Пётр Петрович',
  role: 'supervisor',
  department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок' },
  status: 'active',
  email: 'supervisor@logbook.local',
};

const incoming: ApiUser = {
  id: '01930000-0000-7000-8000-000000000104',
  full_name: 'Смирнов Пётр Ильич',
  role: 'supervisor',
  department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок' },
  status: 'active',
  email: 'supervisor2@logbook.local',
};

const worker: ApiUser = {
  ...incoming,
  id: '01930000-0000-7000-8000-000000000101',
  full_name: 'Иванов Иван Иванович',
  role: 'worker',
  email: 'worker@logbook.local',
};

const handover = {
  journal_id: DEFAULT_JOURNAL_ID,
  shift_date: '2026-11-24',
  period_start: '2026-11-24T05:00:00.000Z',
  period_end: '2026-11-24T17:00:00.000Z',
  handover_comment: 'Смена сдана, журнал проверен',
};

beforeEach(async () => {
  for (const table of db.tables) {
    await table.clear();
  }
  // The sync call after a local decision must not reach the network in tests.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new Error('offline in test')),
  );
  useAuthStore.setState({ user: incoming, initialized: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ signature: null });
  useSyncStore.setState({ pending: 0, dead: 0, conflicts: 0, status: 'idle' });
});

describe('ShiftsScreen (S-15)', () => {
  it('lists a handed-over shift and accepts it offline', async () => {
    const shift = await createShiftLocal(handover, outgoing);

    render(
      <MemoryRouter>
        <ShiftsScreen />
      </MemoryRouter>,
    );

    expect(await screen.findByText(handover.handover_comment)).toBeInTheDocument();
    expect(screen.getByText('Сдана, ожидает приёмки')).toBeInTheDocument();
    expect(screen.getByText(/Петров Пётр Петрович/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Принять смену' }));

    await waitFor(async () => {
      const stored = await getLocalShift(shift.id);
      expect(stored?.status).toBe('accepted');
      expect(stored?.accepted_by).toBe(incoming.id);
    });
    expect(await screen.findByText('Принята')).toBeInTheDocument();
  });

  it('rejects a shift with a reason from the screen', async () => {
    const shift = await createShiftLocal(handover, outgoing);

    render(
      <MemoryRouter>
        <ShiftsScreen />
      </MemoryRouter>,
    );

    await screen.findByText(handover.handover_comment);
    await userEvent.click(screen.getByRole('button', { name: 'Отклонить' }));
    await userEvent.type(
      screen.getByLabelText('Причина отклонения смены'),
      'Нет ведомостей замеров',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Подтвердить отклонение' }),
    );

    await waitFor(async () => {
      const stored = await getLocalShift(shift.id);
      expect(stored?.status).toBe('rejected');
      expect(stored?.rejection_reason).toBe('Нет ведомостей замеров');
    });
    expect(await screen.findByText('Отклонена')).toBeInTheDocument();
  });

  it('renders the printable handover act', async () => {
    await createShiftLocal(handover, outgoing);
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => undefined);

    render(
      <MemoryRouter>
        <ShiftsScreen />
      </MemoryRouter>,
    );

    await screen.findByText(handover.handover_comment);
    await userEvent.click(screen.getByRole('button', { name: 'Печать' }));

    expect(
      await screen.findByRole('article', { name: 'Печатная форма смены' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Акт сдачи-приёмки смены')).toBeInTheDocument();
    expect(screen.getByText(/Сдающий: ______________/)).toBeInTheDocument();
    await waitFor(() => expect(printSpy).toHaveBeenCalled());
  });

  it('does not offer handover to a worker', async () => {
    useAuthStore.setState({ user: worker, initialized: true });
    render(
      <MemoryRouter>
        <ShiftsScreen />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText(/выполняет руководитель или администратор/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Сдать смену' }),
    ).not.toBeInTheDocument();
  });

  it('shows the ЭП hint, offline queue state and the shift entries link', async () => {
    useAuthStore.setState({
      signature: {
        provider: 'simple',
        algorithm: 'HMAC-SHA256',
        auto_sign: true,
        legal_note: 'Простая ЭП не является КЭП.',
      },
    });
    useSyncStore.setState({ pending: 2 });
    const shift = await createShiftLocal(handover, outgoing);

    render(
      <MemoryRouter>
        <ShiftsScreen />
      </MemoryRouter>,
    );

    await screen.findByText(handover.handover_comment);
    const hints = screen.getAllByTestId('signature-hint');
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]).toHaveTextContent('не является КЭП');
    expect(screen.getByTestId('offline-status-bar')).toHaveTextContent(
      '2 изменений ожидают отправки',
    );
    expect(screen.getByRole('link', { name: 'Записи смены' })).toHaveAttribute(
      'href',
      `/?shift_id=${shift.id}`,
    );
  });
});
