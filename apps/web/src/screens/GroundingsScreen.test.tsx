import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_JOURNAL_ID } from '@logbook/shared';
import type { Grounding } from '@logbook/shared';
import { db } from '../db/schema';
import { GroundingsScreen } from './GroundingsScreen';

function grounding(overrides: Partial<Grounding> = {}): Grounding {
  return {
    id: '01930000-0000-7000-8000-000000001201',
    journal_id: DEFAULT_JOURNAL_ID,
    site_id: '01930000-0000-7000-8000-000000000402',
    point: 'КЛ-10 кВ, яч. 5',
    grounding_type: 'portable',
    tool_number: 'T-1',
    count: 1,
    state: 'applied',
    applied_entry_id: '01930000-0000-7000-8000-000000000801',
    applied_by: '01930000-0000-7000-8000-000000000101',
    applied_at: '2026-11-25T08:10:00.000Z',
    removed_entry_id: null,
    removed_by: null,
    removed_at: null,
    version: 1,
    applied_by_name: 'Иванов Иван Иванович',
    site_name: 'Площадка А',
    updated_at_server: '2026-11-25T08:10:00.000Z',
    ...overrides,
  };
}

beforeEach(async () => {
  for (const table of db.tables) {
    await table.clear();
  }
  await db.journals.put({
    id: DEFAULT_JOURNAL_ID,
    journal_key: 'main',
    name: 'Основной оперативный журнал',
    description: null,
    active: true,
    sort_order: 10,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GroundingsScreen (S-16)', () => {
  it('renders the registry and filters by state', async () => {
    await db.groundings.bulkPut([
      grounding(),
      grounding({
        id: '01930000-0000-7000-8000-000000001202',
        point: 'КЛ-10 кВ, яч. 6',
        state: 'removed',
        removed_at: '2026-11-25T09:30:00.000Z',
        removed_by_name: 'Петров Пётр Петрович',
        version: 2,
        updated_at_server: '2026-11-25T09:30:00.000Z',
      }),
    ]);

    render(
      <MemoryRouter>
        <GroundingsScreen />
      </MemoryRouter>,
    );

    expect(await screen.findByText('КЛ-10 кВ, яч. 5')).toBeInTheDocument();
    // Default filter shows active groundings only.
    expect(screen.queryByText('КЛ-10 кВ, яч. 6')).not.toBeInTheDocument();
    expect(screen.getByText('Установлено')).toBeInTheDocument();
    // S-05 integration: the registry row links to the source entry.
    expect(screen.getByRole('link', { name: 'Открыть' })).toHaveAttribute(
      'href',
      '/entries/01930000-0000-7000-8000-000000000801',
    );
    expect(screen.getByTestId('offline-status-bar')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'События заземлений' }),
    ).toHaveAttribute('href', '/?event_type=grounding');

    await userEvent.selectOptions(
      screen.getByLabelText('Фильтр заземлений по состоянию'),
      '',
    );
    expect(await screen.findByText('КЛ-10 кВ, яч. 6')).toBeInTheDocument();
    expect(screen.getByText('Снято')).toBeInTheDocument();
    expect(screen.getAllByText(/Петров Пётр Петрович/).length).toBeGreaterThan(0);
  });

  it('prints the registry', async () => {
    await db.groundings.put(grounding());
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => undefined);

    render(
      <MemoryRouter>
        <GroundingsScreen />
      </MemoryRouter>,
    );

    await screen.findByText('КЛ-10 кВ, яч. 5');
    await userEvent.click(screen.getByRole('button', { name: 'Печать реестра' }));
    await waitFor(() => expect(printSpy).toHaveBeenCalled());
  });

  it('shows an empty state without grounding rows', async () => {
    render(
      <MemoryRouter>
        <GroundingsScreen />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Заземлений нет')).toBeInTheDocument();
  });
});
