import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setCsrfToken } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  setCsrfToken('');
  document.cookie = 'lb_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  vi.restoreAllMocks();
});

describe('API client', () => {
  it('adds X-CSRF-Token from the cookie to unsafe methods', async () => {
    document.cookie = 'lb_csrf=csrf-from-cookie; path=/';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ ok: true }));

    await api.logout();

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe(
      'csrf-from-cookie',
    );
    expect(init.credentials).toBe('include');
  });

  it('remembers the login CSRF token as a fallback', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          user: {
            id: 'u1',
            full_name: 'User',
            role: 'worker',
            department: { id: 'd1', name: 'D' },
            status: 'active',
            email: 'u@example.test',
          },
          session: {
            offline_valid_until: '2026-12-24T00:00:00.000Z',
            refresh_expires_at: '2026-12-24T00:00:00.000Z',
          },
          csrf_token: 'csrf-from-login',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await api.login('u@example.test', 'secret');
    await api.logout();

    const second = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(second.headers).get('X-CSRF-Token')).toBe(
      'csrf-from-login',
    );
  });

  it('parses the unified error envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'E-AUTH-01',
            message: 'Требуется вход',
            fields: { email: 'Неверный email' },
            request_id: 'req_test',
          },
        },
        401,
      ),
    );

    await expect(api.me()).rejects.toMatchObject({
      code: 'E-AUTH-01',
      status: 401,
      fields: { email: 'Неверный email' },
      requestId: 'req_test',
    } satisfies Partial<ApiError>);
  });

  it('maps a network failure to E-NET-01', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    await expect(api.me()).rejects.toMatchObject({
      code: 'E-NET-01',
      status: 0,
    });
  });
});
