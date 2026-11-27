import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { AdminDepartment, AdminUser } from '../../api/types';
import { AdminUsersScreen } from './AdminUsersScreen';

const admin: AdminUser = {
  id: '01930000-0000-7000-8000-000000000103',
  external_id: 'ext-admin',
  full_name: 'Сидоров Сергей Сергеевич',
  email: 'admin@logbook.local',
  role: 'admin',
  department_id: '01930000-0000-7000-8000-000000000001',
  department_name: 'Участок №3',
  position: 'Начальник',
  status: 'active',
  version: 1,
  created_at: '2026-11-01T08:00:00.000Z',
  updated_at: '2026-11-20T08:00:00.000Z',
};

const worker: AdminUser = {
  ...admin,
  id: '01930000-0000-7000-8000-000000000101',
  email: 'worker@logbook.local',
  full_name: 'Иванов Иван Иванович',
  role: 'worker',
  position: 'Электромонтёр',
};

const departments: AdminDepartment[] = [
  { id: '01930000-0000-7000-8000-000000000001', name: 'Участок №3', parent_id: null },
];

beforeEach(() => {
  vi.spyOn(api, 'adminUsers').mockResolvedValue({ items: [admin, worker], total: 2 });
  vi.spyOn(api, 'adminDepartments').mockResolvedValue({ items: departments });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AdminUsersScreen', () => {
  it('lists users and filters them', async () => {
    render(
      <MemoryRouter>
        <AdminUsersScreen />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Иванов Иван Иванович')).toBeInTheDocument();
    expect(screen.getByText('2 учётных записей · роли и статусы (ADM-01/ADM-02)'))
      .toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Поиск пользователей'), 'Иванов');
    await waitFor(() =>
      expect(api.adminUsers).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'Иванов' }),
      ),
    );
    await userEvent.selectOptions(screen.getByLabelText('Фильтр по роли'), 'worker');
    await waitFor(() =>
      expect(api.adminUsers).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'worker' }),
      ),
    );
  });

  it('creates a user through the form', async () => {
    const create = vi.spyOn(api, 'adminCreateUser').mockResolvedValue(worker);
    render(
      <MemoryRouter>
        <AdminUsersScreen />
      </MemoryRouter>,
    );
    await screen.findByText('Иванов Иван Иванович');

    await userEvent.click(screen.getByRole('button', { name: '+ Пользователь' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Email *' }), 'new@logbook.local');
    await userEvent.type(screen.getByRole('textbox', { name: 'ФИО *' }), 'Новый Сотрудник');
    await userEvent.type(
      screen.getByLabelText(/Пароль для входа/),
      'DemoPass!2026',
    );
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Подразделение *' }),
      departments[0]!.id,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Создать' }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'new@logbook.local',
          full_name: 'Новый Сотрудник',
          role: 'worker',
          department_id: departments[0]!.id,
          password: 'DemoPass!2026',
        }),
      ),
    );
  });

  it('changes the status and revokes sessions', async () => {
    const patch = vi.spyOn(api, 'adminPatchUser').mockResolvedValue({
      ...worker,
      status: 'blocked',
    });
    const revoke = vi
      .spyOn(api, 'adminRevokeSessions')
      .mockResolvedValue({ ok: true, revoked: 2 });
    render(
      <MemoryRouter>
        <AdminUsersScreen />
      </MemoryRouter>,
    );
    await screen.findByText('Иванов Иван Иванович');

    await userEvent.click(screen.getAllByRole('button', { name: 'Изменить' })[1]!);
    await userEvent.selectOptions(
      screen.getByLabelText('Статус Иванов Иван Иванович'),
      'blocked',
    );
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(worker.id, { status: 'blocked' }),
    );

    await userEvent.click(
      screen.getAllByRole('button', { name: 'Завершить сессии' })[1]!,
    );
    await waitFor(() => expect(revoke).toHaveBeenCalledWith(worker.id));
  });

  it('shows an error when the directory request fails', async () => {
    vi.spyOn(api, 'adminUsers').mockRejectedValueOnce(new Error('нет доступа'));
    render(
      <MemoryRouter>
        <AdminUsersScreen />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('нет доступа');
  });
});
