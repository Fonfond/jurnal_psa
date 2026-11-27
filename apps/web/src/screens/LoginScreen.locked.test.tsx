import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { LoginScreen } from './LoginScreen';

const unlockOk = {
  ok: true as const,
  record: {
    version: 1 as const,
    user: {
      id: '01930000-0000-7000-8000-000000000101',
      full_name: 'Иван Петров',
      role: 'worker' as const,
      department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок №3' },
      status: 'active' as const,
      email: 'worker@logbook.local',
    },
    session: {
      offline_valid_until: '2026-12-25T10:00:00.000Z',
      refresh_expires_at: '2026-12-25T10:00:00.000Z',
    },
    pin: {
      algorithm: 'PBKDF2-SHA256' as const,
      salt: 'salt',
      iterations: 150_000,
      hash: 'hash',
    },
    locked: false,
    failed_attempts: 0,
    locked_until: null,
    created_at: '2026-11-25T10:00:00.000Z',
    updated_at: '2026-11-25T10:00:00.000Z',
  },
};

beforeEach(() => {
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
  useAuthStore.setState({
    user: null,
    session: null,
    loading: false,
    initialized: true,
    error: null,
    locked: true,
    offline: false,
    pinConfigured: true,
    signature: null,
    features: null,
    unlockWithPin: vi.fn(async () => unlockOk),
  });
});

function renderLogin(): void {
  render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginScreen />} />
        <Route path="/" element={<div>Журнал открыт</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('LoginScreen local unlock (AUTH-03)', () => {
  it('unlocks a locked session with a PIN', async () => {
    const unlock = vi.fn(async () => unlockOk);
    useAuthStore.setState({ unlockWithPin: unlock });
    renderLogin();

    expect(screen.getByRole('heading', { name: 'Сессия заблокирована' }))
      .toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('PIN-код'), '2468');
    await userEvent.click(screen.getByRole('button', { name: 'Разблокировать' }));

    await waitFor(() => expect(unlock).toHaveBeenCalledWith('2468'));
    expect(await screen.findByText('Журнал открыт')).toBeInTheDocument();
  });

  it('shows the wrong-PIN message from the verifier', async () => {
    const unlock = vi.fn(async () => ({
      ok: false as const,
      reason: 'wrong-pin' as const,
      message: 'Неверный PIN. Осталось попыток: 4',
      attempts_left: 4,
      locked_until: null,
    }));
    useAuthStore.setState({ unlockWithPin: unlock });
    renderLogin();

    await userEvent.type(screen.getByLabelText('PIN-код'), '1357');
    await userEvent.click(screen.getByRole('button', { name: 'Разблокировать' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Неверный PIN. Осталось попыток: 4',
    );
    expect(screen.getByLabelText('PIN-код')).toHaveValue('');
  });

  it('falls back to password login when no PIN was configured', () => {
    useAuthStore.setState({ pinConfigured: false });
    renderLogin();

    expect(screen.getByText(/PIN не задан/)).toBeInTheDocument();
    expect(screen.queryByLabelText('PIN-код')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Войти' })).toBeInTheDocument();
  });

  it('explains offline unlock when the network is down', () => {
    useAuthStore.setState({ locked: true, offline: true, pinConfigured: true });
    renderLogin();

    expect(
      screen.getByText(/Сети нет — доступна офлайн-разблокировка по PIN/),
    ).toBeInTheDocument();
  });
});
