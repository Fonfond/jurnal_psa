import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED_UUIDS, type ConflictRecord } from '@logbook/shared';
import { api } from '../api/client';
import type { ApiUser } from '../api/types';
import { createLocalEntry } from '../db/repositories';
import { db } from '../db/schema';
import { useAuthStore } from '../stores/auth';
import { ConflictsScreen } from './ConflictsScreen';

const supervisor: ApiUser = {
  id: SEED_UUIDS.supervisor,
  full_name: 'Петров Пётр Петрович',
  role: 'supervisor',
  department: { id: SEED_UUIDS.departmentMain, name: 'Участок №3' },
  status: 'active',
  email: 'supervisor@logbook.local',
};

const conflict: ConflictRecord = {
  id: '01930000-0000-7000-8000-000000005001',
  entry_id: '',
  field: 'text',
  local_value: 'Текст с устройства',
  remote_value: 'Текст с сервера',
  local_hlc: '1795000000200:00001:test0001',
  remote_hlc: '1795000000300:00002:test0002',
  resolution: 'pending',
  resolved_by: null,
  resolved_at: null,
};

beforeEach(async () => {
  for (const table of db.tables) {
    await table.clear();
  }
  useAuthStore.setState({ user: supervisor, initialized: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.setState({ user: null });
});

describe('ConflictsScreen (S-13)', () => {
  it('renders a server conflict pulled into Dexie and resolves it', async () => {
    const entry = await createLocalEntry(
      {
        performed_at: '2026-11-25T08:00:00.000Z',
        performed_tz_offset_min: 480,
        work_type_id: SEED_UUIDS.workTypePermit,
        site_id: SEED_UUIDS.siteWorkshop,
        permit_id: null,
        text: 'Текст с устройства',
        input_method: 'manual',
      },
      supervisor,
    );
    // This is what pullServerConflicts writes for a conflict created on
    // another device (GET /v1/conflicts → Dexie conflicts).
    await db.conflicts.put({ ...conflict, entry_id: entry.id });
    const resolve = vi
      .spyOn(api, 'resolveConflict')
      .mockResolvedValue({ id: conflict.id, resolution: 'remote', entry_version: 2 });

    render(
      <MemoryRouter>
        <ConflictsScreen />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Поле: text')).toBeInTheDocument();
    expect(screen.getAllByText(/Текст с устройства/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Текст с сервера/).length).toBeGreaterThan(0);
    expect(screen.getByText('1 ждут решения')).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'Принять серверное' }),
    );

    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith(conflict.id, { resolution: 'remote' }),
    );
    await waitFor(async () =>
      expect((await db.conflicts.get(conflict.id))?.resolution).toBe('remote'),
    );
  });

  it('shows the empty state when no conflicts were pulled', async () => {
    render(
      <MemoryRouter>
        <ConflictsScreen />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Конфликтов нет')).toBeInTheDocument();
  });
});
