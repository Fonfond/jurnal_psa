import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { ApiUser } from '../api/types';
import { useAuthStore } from '../stores/auth';
import { LoginScreen } from './LoginScreen';

const worker: ApiUser = {
  id: '01930000-0000-7000-8000-000000000101',
  full_name: 'Иван Петров',
  role: 'worker',
  department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок' },
  status: 'active',
  email: 'worker@logbook.local',
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
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LoginScreen', () => {
  it('logs in through a quick dev role and navigates to the journal', async () => {
    const login = vi.spyOn(api, 'login').mockResolvedValue({
      user: worker,
      session: {
        offline_valid_until: '2026-12-24T08:00:00.000Z',
        refresh_expires_at: '2026-12-24T08:00:00.000Z',
      },
      csrf_token: 'csrf-token',
    });

    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginScreen />} />
          <Route path="/" element={<div>Журнал открыт</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await userEvent.click(
      screen.getByRole('button', { name: /Сотрудник/i }),
    );

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith(
        'worker@logbook.local',
        'Logbook!2026',
      );
    });
    expect(await screen.findByText('Журнал открыт')).toBeInTheDocument();
  });

  it('shows an accessible error for invalid credentials', async () => {
    const { ApiError } = await import('../api/client');
    vi.spyOn(api, 'login').mockRejectedValue(
      new ApiError(401, 'E-AUTH-01', 'Неверный email или пароль'),
    );

    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginScreen />} />
        </Routes>
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole('button', { name: /Войти/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Неверный email или пароль',
    );
  });

  it('offers OIDC login and hides the password form when the provider is oidc', async () => {
    vi.spyOn(api, 'authConfig').mockResolvedValue({
      auth_provider: 'oidc',
      dev_login_enabled: false,
      oidc: {
        display_name: 'Корпоративный IdP',
        authorize_url: '/v1/auth/authorize',
      },
      signature: {
        provider: 'simple',
        algorithm: 'HMAC-SHA256',
        auto_sign: true,
        legal_note: 'Простая ЭП',
      },
    });

    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginScreen />} />
        </Routes>
      </MemoryRouter>,
    );

    const link = await screen.findByTestId('sso-login');
    expect(link).toHaveAttribute('href', expect.stringContaining('/auth/authorize'));
    expect(screen.queryByLabelText('Пароль')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Сотрудник/i })).not.toBeInTheDocument();
  });
});
