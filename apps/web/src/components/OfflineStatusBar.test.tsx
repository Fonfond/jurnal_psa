import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSyncStore } from '../stores/sync';
import { OfflineStatusBar } from './OfflineStatusBar';

beforeEach(() => {
  useSyncStore.setState({
    status: 'idle',
    pending: 0,
    dead: 0,
    conflicts: 0,
    lastSync: '2026-11-24T08:00:00.000Z',
    sync: vi.fn(async () => ({
      status: 'ok' as const,
      pushed: 0,
      pulled: 0,
      conflicts: 0,
    })),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderBar(compact = false): void {
  render(
    <MemoryRouter>
      <OfflineStatusBar compact={compact} />
    </MemoryRouter>,
  );
}

describe('OfflineStatusBar', () => {
  it('says everything is synced when the outbox is empty', () => {
    renderBar();
    expect(screen.getByTestId('offline-status-bar')).toHaveTextContent(
      'Все изменения синхронизированы',
    );
    expect(screen.getByText(/обновлено/)).toBeInTheDocument();
  });

  it('shows pending changes and triggers a sync without a compact button', async () => {
    useSyncStore.setState({ pending: 3 });
    renderBar();

    expect(screen.getByText('3 изменений ожидают отправки')).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Синхронизировать' }),
    );
    expect(useSyncStore.getState().sync).toHaveBeenCalled();
  });

  it('links to the queue and conflicts when something needs attention', () => {
    useSyncStore.setState({ dead: 1, conflicts: 2 });
    renderBar();

    expect(screen.getByText(/1 операций с ошибкой/)).toBeInTheDocument();
    expect(screen.getByText(/2 конфликтов/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Разобрать очередь' })).toHaveAttribute(
      'href',
      '/sync',
    );

    useSyncStore.setState({ dead: 0, conflicts: 2 });
    renderBar();
    expect(screen.getAllByRole('link', { name: 'Открыть конфликты' })[0]).toHaveAttribute(
      'href',
      '/conflicts',
    );
  });

  it('renders the offline wording without a sync button in compact mode', () => {
    const getter = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    useSyncStore.setState({ pending: 2 });
    renderBar(true);

    expect(screen.getByTestId('offline-status-bar')).toHaveTextContent(
      'Офлайн: 2 изменений сохранено на устройстве',
    );
    expect(
      screen.queryByRole('button', { name: 'Синхронизировать' }),
    ).not.toBeInTheDocument();
    getter.mockRestore();
  });
});
