import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import type { AuthConfigResponse } from '@logbook/shared';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';

const DEV_PASSWORD = import.meta.env.VITE_DEV_PASSWORD ?? 'Logbook!2026';
const FALLBACK_DEV_LOGIN_ENABLED =
  !import.meta.env.PROD && import.meta.env.VITE_ENABLE_DEV_LOGIN !== 'false';

const QUICK_USERS = [
  { email: 'worker@logbook.local', label: 'Сотрудник', hint: 'свои записи' },
  { email: 'supervisor@logbook.local', label: 'Руководитель', hint: 'проверка' },
  { email: 'admin@logbook.local', label: 'Администратор', hint: 'все права' },
];

export function LoginScreen(): JSX.Element {
  const user = useAuthStore((state) => state.user);
  const locked = useAuthStore((state) => state.locked);
  const offline = useAuthStore((state) => state.offline);
  const pinConfigured = useAuthStore((state) => state.pinConfigured);
  const unlockWithPin = useAuthStore((state) => state.unlockWithPin);
  const login = useAuthStore((state) => state.login);
  const loading = useAuthStore((state) => state.loading);
  const storeError = useAuthStore((state) => state.error);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [authConfig, setAuthConfig] = useState<AuthConfigResponse | null>(null);
  const [email, setEmail] = useState(
    FALLBACK_DEV_LOGIN_ENABLED ? 'worker@logbook.local' : '',
  );
  const [password, setPassword] = useState(
    FALLBACK_DEV_LOGIN_ENABLED ? DEV_PASSWORD : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .authConfig()
      .then((config) => {
        if (active) {
          setAuthConfig(config);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  if (user) {
    return <Navigate to="/" replace />;
  }

  const oidcMode = authConfig?.auth_provider === 'oidc';
  const devLoginEnabled = authConfig
    ? authConfig.dev_login_enabled
    : FALLBACK_DEV_LOGIN_ENABLED;
  const callbackError = searchParams.get('auth_error')
    ? (searchParams.get('message') ??
      `Не удалось войти через IdP (${searchParams.get('auth_error')})`)
    : null;

  const submit = async (nextEmail = email, nextPassword = password): Promise<void> => {
    setError(null);
    setFieldErrors({});
    try {
      await login(nextEmail, nextPassword);
      navigate('/', { replace: true });
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
        setFieldErrors(caught.fields ?? {});
      } else {
        setError(caught instanceof Error ? caught.message : 'Не удалось войти');
      }
    }
  };

  const unlock = async (): Promise<void> => {
    setPinError(null);
    setPinBusy(true);
    try {
      const result = await unlockWithPin(pin.trim());
      if (result.ok) {
        navigate('/', { replace: true });
      } else {
        setPinError(result.message);
        setPin('');
      }
    } catch (caught) {
      setPinError(
        caught instanceof Error ? caught.message : 'Не удалось разблокировать',
      );
    } finally {
      setPinBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-brand">
          <span className="login-brand__mark">ЭОЖ</span>
          <div>
            <p className="eyebrow">Электронный оперативный журнал</p>
            <h1>Logbook</h1>
          </div>
        </div>
        <p className="login-lead">
          Работает офлайн: запись сохраняется на устройстве и синхронизируется
          при подключении.
        </p>

        {locked ? (
          <section className="card locked-panel" aria-label="Разблокировка сессии">
            <h2>Сессия заблокирована</h2>
            <p className="hint">
              Локальные данные сохранены на устройстве.{' '}
              {offline
                ? 'Сети нет — доступна офлайн-разблокировка по PIN.'
                : 'Разблокируйте PIN-кодом или войдите по паролю.'}
            </p>
            {pinConfigured ? (
              <form
                className="form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void unlock();
                }}
              >
                <label className="field">
                  <span>PIN-код</span>
                  <input
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    pattern="\d{4,8}"
                    maxLength={8}
                    value={pin}
                    onChange={(event) => setPin(event.target.value)}
                    aria-label="PIN-код"
                    autoFocus
                    required
                  />
                </label>
                {pinError ? (
                  <div className="alert alert--danger" role="alert">
                    {pinError}
                  </div>
                ) : null}
                <button
                  type="submit"
                  className="button button--primary"
                  disabled={pinBusy || pin.length < 4}
                >
                  {pinBusy ? 'Проверяем…' : 'Разблокировать'}
                </button>
                <p className="hint">
                  5 неверных попыток блокируют разблокировку на 5 минут.
                </p>
              </form>
            ) : (
              <div className="alert alert--warning" role="status">
                PIN не задан. Войдите по паролю — после входа PIN можно задать в
                разделе «Синхронизация» → «Безопасность».
              </div>
            )}
          </section>
        ) : null}

        {oidcMode ? (
          <section className="quick-login" aria-label="Вход через IdP">
            <p className="quick-login__title">
              Вход через {authConfig?.oidc?.display_name ?? 'корпоративный IdP'}
            </p>
            <a
              className="button button--primary"
              href={api.authorizeUrl('/')}
              data-testid="sso-login"
            >
              Войти через IdP
            </a>
            <p className="hint">
              OIDC Authorization Code + PKCE. Отдельной регистрации нет: учётную
              запись создаёт администратор.
            </p>
          </section>
        ) : null}

        {!oidcMode && devLoginEnabled ? (
          <section className="quick-login" aria-label="Быстрый вход">
            <p className="quick-login__title">Демо-доступ (dev)</p>
            <div className="quick-login__grid">
              {QUICK_USERS.map((item) => (
                <button
                  key={item.email}
                  type="button"
                  className="quick-login__button"
                  disabled={loading}
                  onClick={() => void submit(item.email, DEV_PASSWORD)}
                >
                  <strong>{item.label}</strong>
                  <span>{item.hint}</span>
                </button>
              ))}
            </div>
            <p className="hint">
              Dev-провайдер (ADR-22) только для локального запуска. В production —
              OIDC + PKCE (OQ-02).
            </p>
          </section>
        ) : null}

        {!oidcMode ? (
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
              {fieldErrors.email ? (
                <span className="field__error">{fieldErrors.email}</span>
              ) : null}
            </label>
            <label className="field">
              <span>Пароль</span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              {fieldErrors.password ? (
                <span className="field__error">{fieldErrors.password}</span>
              ) : null}
            </label>

            {callbackError ?? error ?? storeError ? (
              <div className="alert alert--danger" role="alert">
                {callbackError ?? error ?? storeError}
              </div>
            ) : null}

            <button type="submit" className="button button--primary" disabled={loading}>
              {loading ? 'Вход…' : 'Войти'}
            </button>
          </form>
        ) : null}

        {oidcMode && (callbackError ?? storeError) ? (
          <div className="alert alert--danger" role="alert">
            {callbackError ?? storeError}
          </div>
        ) : null}
      </div>
    </div>
  );
}
