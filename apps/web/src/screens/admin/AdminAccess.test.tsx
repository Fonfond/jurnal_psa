import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { ApiUser } from '../../api/types';
import { App } from '../../app/App';
import { useAuthStore } from '../../stores/auth';
// The shell starts sync triggers; routing tests do not need Dexie/service worker.
vi.mock('../../sync/triggers', () => ({
  startSyncTriggers: () => () => undefined,
}));

const admin: ApiUser = {
  id: '01930000-0000-7000-8000-000000000103',
  full_name: 'Сидоров Сергей Сергеевич',
  role: 'admin',
  department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок №3' },
  status: 'active',
  email: 'admin@logbook.local',
};

const worker: ApiUser = {
  ...admin,
  id: '01930000-0000-7000-8000-000000000101',
  full_name: 'Иванов Иван Иванович',
  role: 'worker',
  email: 'worker@logbook.local',
};

beforeEach(() => {
  useAuthStore.setState({
    user: null,
    session: null,
    initialized: true,
    locked: false,
    signature: null,
    features: null,
  });
  vi.spyOn(api, 'adminUsers').mockResolvedValue({ items: [], total: 0 });
  vi.spyOn(api, 'adminDevices').mockResolvedValue({ items: [], total: 0 });
  vi.spyOn(api, 'journals').mockResolvedValue({ items: [] });
  vi.spyOn(api, 'exports').mockResolvedValue({ items: [], total: 0 });
  vi.spyOn(api, 'retention').mockResolvedValue({
    policy_years: 3,
    cutoff: '2023-11-25',
    journal_entries: {
      total: 0,
      deleted: 0,
      before_cutoff: 0,
      oldest: null,
      newest: null,
    },
    runs: [],
    checkpoints: [],
    latest_run: null,
  });
  vi.spyOn(api, 'audit').mockResolvedValue({ items: [] });

});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.pushState({}, '', '/');
});

describe('admin contour guard (ADR-14)', () => {
  it('blocks non-admin users and explains the reason', () => {
    useAuthStore.setState({ user: worker, initialized: true });
    window.history.pushState({}, '', '/admin');
    render(<App />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Администрирование доступно только администратору',
    );
    expect(screen.queryByRole('link', { name: 'Пользователи' })).not.toBeInTheDocument();
  });

  it('shows the admin shell to an administrator', async () => {
    useAuthStore.setState({ user: admin, initialized: true });
    window.history.pushState({}, '', '/admin');
    render(<App />);

    expect(
      await screen.findByRole('navigation', { name: 'Разделы администрирования' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Пользователи' })).toHaveAttribute(
      'href',
      '/admin/users',
    );
    expect(screen.getByText('Администрирование')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'К журналу' })).toHaveAttribute(
      'href',
      '/',
    );
  });
});
