import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { ApiUser } from '../api/types';
import { getDeviceMeta } from '../db/device-db';
import { rememberOfflineSession, offlineSessionKey } from '../auth/offline-session';
import { activateUserDatabase } from '../db/user-db';
import { useAuthStore } from '../stores/auth';
import { SyncScreen } from './SyncScreen';

const user: ApiUser = {
  id: '01930000-0000-7000-8000-000000000101',
  full_name: 'Иван Петров',
  role: 'worker',
  department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок №3' },
  status: 'active',
  email: 'worker@logbook.local',
};

const session = {
  offline_valid_until: '2026-12-25T10:00:00.000Z',
  refresh_expires_at: '2026-12-25T10:00:00.000Z',
};

beforeEach(async () => {
  vi.spyOn(api, 'authConfig').mockResolvedValue({
    auth_provider: 'dev',
    dev_login_enabled: true,
    oidc: null,
    signature: {
      provider: 'none',
      algorithm: null,
      auto_sign: false,
      legal_note: 'ЭП не настроена',
    },
  });
  await activateUserDatabase(user.id);
  await rememberOfflineSession(user, session);
  useAuthStore.setState({
    user,
    session,
    initialized: true,
    locked: false,
    pinConfigured: false,
  });
});

describe('SyncScreen security card (AUTH-03)', () => {
  it('sets and removes the local PIN without storing it in clear text', async () => {
    render(
      <MemoryRouter>
        <SyncScreen />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Безопасность')).toBeInTheDocument();
    expect(screen.getByText('PIN не задан')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('PIN для разблокировки'), '2468');
    await userEvent.click(screen.getByRole('button', { name: 'Задать PIN' }));

    expect(await screen.findByText(/PIN сохранён/)).toBeInTheDocument();
    expect(screen.getByText('PIN задан')).toBeInTheDocument();
    const raw = await getDeviceMeta(offlineSessionKey(user.id));
    expect(raw).not.toContain('2468');
    expect(raw).toContain('PBKDF2-SHA256');

    await userEvent.click(screen.getByRole('button', { name: 'Удалить PIN' }));
    await waitFor(() => expect(screen.getByText(/PIN удалён/)).toBeInTheDocument());
    expect(screen.getByText('PIN не задан')).toBeInTheDocument();
  });
});
