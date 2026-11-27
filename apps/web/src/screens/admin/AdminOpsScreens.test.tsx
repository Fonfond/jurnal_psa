import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_JOURNAL_ID } from '@logbook/shared';
import { api } from '../../api/client';
import type {
  AdminDevice,
  AdminUser,
  AuditEventRow,
  ExportJobRow,
  RetentionStatus,
} from '../../api/types';
import { AdminDevicesScreen } from './AdminDevicesScreen';
import { AdminExportsScreen } from './AdminExportsScreen';
import { AdminImportsScreen } from './AdminImportsScreen';
import { AdminRetentionScreen } from './AdminRetentionScreen';
import { AdminAuditScreen } from './AdminAuditScreen';
import { AdminJournalsScreen } from './AdminJournalsScreen';

const device: AdminDevice = {
  id: '01930000-0000-7000-8000-000000000201',
  user_id: '01930000-0000-7000-8000-000000000101',
  user_name: 'Иванов Иван Иванович',
  user_email: 'worker@logbook.local',
  install_id: 'install-1',
  name: 'Android D1',
  platform: 'Android 14',
  app_version: '0.3.0',
  status: 'active',
  device_key_set: true,
  last_seen_at: '2026-11-25T08:00:00.000Z',
};

const auditRow: AuditEventRow = {
  id: '01930000-0000-7000-8000-000000004401',
  occurred_at: '2026-11-25T08:00:00.000Z',
  actor_id: '01930000-0000-7000-8000-000000000103',
  actor_role: 'admin',
  action: 'user.update',
  entity_type: 'user',
  entity_id: '01930000-0000-7000-8000-000000000101',
  before: { status: 'active' },
  after: { status: 'blocked' },
  reason: null,
  source: 'server',
  hash: 'a'.repeat(64),
};

const retention: RetentionStatus = {
  policy_years: 3,
  cutoff: '2023-11-25',
  policy: {
    years: 3,
    cutoff: '2023-11-25',
    protected_until_cutoff: '2023-11-25',
    worm_exports: true,
  },
  journal_entries: {
    total: 5,
    active: 4,
    deleted: 1,
    before_cutoff: 0,
    oldest: '2026-11-20T08:00:00.000Z',
    newest: '2026-11-24T08:00:00.000Z',
  },
  exports: { journal_pdf: 1 },
  archives: 1,
  audit: { streams: 4, heads: [] },
  runs: [
    {
      id: 'run-1',
      run_at: '2026-11-25T07:00:00.000Z',
      policy_years: 3,
      cutoff: '2023-11-25',
      audit_ok: true,
      streams_checked: 4,
    },
  ],
  checkpoints: [],
  latest_run: null,
};

const exportJob: ExportJobRow = {
  id: 'export-1',
  type: 'journal_pdf',
  status: 'done',
  journal_id: DEFAULT_JOURNAL_ID,
  file_sha256: 'b'.repeat(64),
  file_size_bytes: 220_000,
  csv_sha256: 'c'.repeat(64),
  csv_size_bytes: 12_000,
  generated_at: '2026-11-25T08:00:00.000Z',
  worm: true,
  download_count: 1,
};

const adminUser: AdminUser = {
  id: '01930000-0000-7000-8000-000000000101',
  external_id: 'ext-worker',
  full_name: 'Иванов Иван Иванович',
  email: 'worker@logbook.local',
  role: 'worker',
  department_id: '01930000-0000-7000-8000-000000000001',
  department_name: 'Участок №3',
  position: null,
  status: 'active',
  version: 1,
  created_at: '2026-11-01T08:00:00.000Z',
  updated_at: '2026-11-20T08:00:00.000Z',
};

beforeEach(() => {
  for (const table of []) {
    void table;
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AdminDevicesScreen', () => {
  it('lists devices and revokes one', async () => {
    vi.spyOn(api, 'adminDevices').mockResolvedValue({ items: [device], total: 1 });
    const revoke = vi
      .spyOn(api, 'adminRevokeDevice')
      .mockResolvedValue({ ok: true, revoked_sessions: 1 });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <MemoryRouter>
        <AdminDevicesScreen />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Android D1')).toBeInTheDocument();
    expect(screen.getByText('Иванов Иван Иванович')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Отозвать' }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith(device.id));
  });
});

describe('AdminImportsScreen', () => {
  it('imports CSV and shows the result and history', async () => {
    vi.spyOn(api, 'adminImports').mockResolvedValue({
      items: [
        {
          id: 'imp-1',
          occurred_at: '2026-11-25T08:00:00.000Z',
          actor_role: 'admin',
          action: 'permit.import',
          after: { source_id: 'csv', imported: 2, updated: 1 },
        },
      ],
    });
    const importPermits = vi.spyOn(api, 'adminImportPermits').mockResolvedValue({
      imported: 2,
      updated: 1,
      errors: [{ row: 3, message: 'Некорректный статус' }],
    });

    render(
      <MemoryRouter>
        <AdminImportsScreen />
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Импортировать' }));
    await waitFor(() =>
      expect(importPermits).toHaveBeenCalledWith(
        expect.objectContaining({ source_id: 'csv', csv: expect.stringContaining('number,status') }),
      ),
    );
    expect(await screen.findByText('Результат')).toBeInTheDocument();
    expect(screen.getByText('Некорректный статус')).toBeInTheDocument();
    expect(await screen.findByText('История импорта')).toBeInTheDocument();
  });
});

describe('AdminRetentionScreen', () => {
  it('shows the policy, runs checks and creates an archive', async () => {
    vi.spyOn(api, 'retention').mockResolvedValue(retention);
    vi.spyOn(api, 'retentionArchives').mockResolvedValue({ items: [] });
    vi.spyOn(api, 'journals').mockResolvedValue({
      items: [
        {
          id: DEFAULT_JOURNAL_ID,
          journal_key: 'main',
          name: 'Основной журнал',
          description: null,
          active: true,
          sort_order: 10,
        },
      ],
    });
    const run = vi.spyOn(api, 'retentionRun').mockResolvedValue({
      id: 'run-2',
      report: {},
      audit_verification: {
        ok: true,
        streams_checked: 5,
        events_checked: 42,
        broken: [],
      },
    });
    const verify = vi.spyOn(api, 'auditVerify').mockResolvedValue({
      ok: true,
      streams_checked: 5,
      events_checked: 42,
      broken: [],
    });
    const archive = vi.spyOn(api, 'retentionArchive').mockResolvedValue({
      archive_id: 'archive-1',
      export: exportJob,
      manifest: {},
      immutable: true,
    });

    render(
      <MemoryRouter>
        <AdminRetentionScreen />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Хранение и архив')).toBeInTheDocument();
    expect(await screen.findByText(/Сроки хранения требуют утверждения/)).toBeInTheDocument();
    expect(screen.getByText('Защищено до')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Выполнить проверку' }));
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(await screen.findByText('Проверка хранения выполнена')).toBeInTheDocument();
    expect(await screen.findByText('42')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Проверить аудит' }));
    await waitFor(() => expect(verify).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: 'Создать архив' }));
    await waitFor(() => expect(archive).toHaveBeenCalled());
  });

  it('is honest when the retention module is not wired yet', async () => {
    vi.spyOn(api, 'retention').mockRejectedValue(new Error('404'));
    vi.spyOn(api, 'retentionArchives').mockResolvedValue({ items: [] });
    vi.spyOn(api, 'journals').mockResolvedValue({ items: [] });
    render(
      <MemoryRouter>
        <AdminRetentionScreen />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Модуль хранения недоступен',
    );
  });
});

describe('AdminExportsScreen', () => {
  it('lists WORM exports, creates one and opens a signed link', async () => {
    vi.spyOn(api, 'exports').mockResolvedValue({ items: [exportJob], total: 1 });
    vi.spyOn(api, 'journals').mockResolvedValue({ items: [] });
    const create = vi.spyOn(api, 'createExport').mockResolvedValue(exportJob);
    const url = vi.spyOn(api, 'exportUrl').mockResolvedValue({
      id: exportJob.id,
      format: 'pdf',
      url: 'https://example.test/signed.pdf',
      expires_at: '2026-11-25T09:00:00.000Z',
      hash: 'b'.repeat(64),
      worm: true,
    });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);

    render(
      <MemoryRouter>
        <AdminExportsScreen />
      </MemoryRouter>,
    );

    expect(await screen.findByText('journal_pdf')).toBeInTheDocument();
    expect(screen.getByText('Да')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Сформировать экспорт' }));
    await waitFor(() => expect(create).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: 'PDF' }));
    await waitFor(() => expect(url).toHaveBeenCalledWith(exportJob.id, 'pdf'));
    expect(open).toHaveBeenCalledWith(
      'https://example.test/signed.pdf',
      '_blank',
      'noopener',
    );
  });
});

describe('AdminAuditScreen', () => {
  it('loads the audit log and applies filters', async () => {
    const audit = vi.spyOn(api, 'audit').mockResolvedValue({ items: [auditRow] });
    render(
      <MemoryRouter>
        <AdminAuditScreen />
      </MemoryRouter>,
    );

    expect(await screen.findByText('user.update')).toBeInTheDocument();
    expect(screen.getByText(/^user ·/)).toBeInTheDocument();

    await userEvent.type(
      screen.getByLabelText('Фильтр аудита по действию'),
      'device',
    );
    await waitFor(() =>
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'device' }),
      ),
    );
  });
});

describe('AdminJournalsScreen', () => {
  it('creates a journal and grants access', async () => {
    vi.spyOn(api, 'journals').mockResolvedValue({
      items: [
        {
          id: DEFAULT_JOURNAL_ID,
          journal_key: 'main',
          name: 'Основной журнал',
          description: null,
          active: true,
          sort_order: 10,
        },
      ],
    });
    vi.spyOn(api, 'adminUsers').mockResolvedValue({
      items: [adminUser],
      total: 1,
    });
    vi.spyOn(api, 'journalMembers').mockResolvedValue({ items: [] });
    const create = vi.spyOn(api, 'createJournal').mockResolvedValue({
      id: 'new-journal',
      journal_key: 'shop-2',
      name: 'Журнал цеха 2',
      description: null,
      active: true,
      sort_order: 100,
    });
    const patch = vi.spyOn(api, 'patchJournal').mockResolvedValue({
      id: DEFAULT_JOURNAL_ID,
      journal_key: 'main',
      name: 'Основной журнал',
      description: null,
      active: false,
      sort_order: 10,
    });
    const grant = vi.spyOn(api, 'grantJournal').mockResolvedValue({ ok: true });

    render(
      <MemoryRouter>
        <AdminJournalsScreen />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Основной журнал')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Ключ *'), 'shop-2');
    await userEvent.type(screen.getByLabelText('Название *'), 'Журнал цеха 2');
    await userEvent.click(screen.getByRole('button', { name: 'Создать журнал' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ journal_key: 'shop-2', name: 'Журнал цеха 2' }),
      ),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Выключить' }));
    await waitFor(() => expect(patch).toHaveBeenCalled());

    await userEvent.selectOptions(
      screen.getByLabelText('Пользователь для гранта'),
      adminUser.id,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Выдать грант' }));
    await waitFor(() =>
      expect(grant).toHaveBeenCalledWith('new-journal', adminUser.id, 'read'),
    );
  });
});
