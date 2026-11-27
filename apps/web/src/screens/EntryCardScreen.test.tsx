import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_JOURNAL_ID,
  type JournalEntry,
  type SignatureRecord,
} from '@logbook/shared';
import { api } from '../api/client';
import type { ApiUser } from '../api/types';
import { createLocalEntry } from '../db/repositories';
import { db } from '../db/schema';
import { createShiftLocal } from '../db/shift-repositories';
import { useAuthStore } from '../stores/auth';
import { EntryCardScreen } from './EntryCardScreen';

const author: ApiUser = {
  id: '01930000-0000-7000-8000-000000000101',
  full_name: 'Иванов Иван Иванович',
  role: 'worker',
  department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок' },
  status: 'active',
  email: 'worker@logbook.local',
};

const supervisor: ApiUser = {
  id: '01930000-0000-7000-8000-000000000102',
  full_name: 'Петров Пётр Петрович',
  role: 'supervisor',
  department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок' },
  status: 'active',
  email: 'supervisor@logbook.local',
};

const entryInput = {
  performed_at: '2026-11-24T08:00:00.000Z',
  performed_tz_offset_min: 480,
  work_type_id: '01930000-0000-7000-8000-000000000302',
  site_id: '01930000-0000-7000-8000-000000000402',
  permit_id: null,
  input_method: 'manual' as const,
};

const visaSignature: SignatureRecord = {
  id: '01930000-0000-7000-8000-000000003101',
  entity_type: 'entry',
  entity_id: '01930000-0000-7000-8000-000000000401',
  entity_version: 2,
  content_hash: 'b'.repeat(64),
  kind: 'simple',
  algorithm: 'HMAC-SHA256',
  value: 'visa-signature',
  key_id: 'key-1',
  certificate_serial: null,
  certificate_subject: null,
  signer_id: supervisor.id,
  signed_at: '2026-11-24T09:00:00.000Z',
  status: 'valid',
  metadata: null,
  legal_note: 'Простая ЭП не является КЭП',
};

const qualifiedSignature: SignatureRecord = {
  ...visaSignature,
  id: '01930000-0000-7000-8000-000000003102',
  kind: 'qualified',
  algorithm: 'GOST R 34.10-2012',
  signed_at: '2026-11-24T09:30:00.000Z',
};

beforeEach(async () => {
  for (const table of db.tables) {
    await table.clear();
  }
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new Error('offline in test')),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useAuthStore.setState({ signature: null, user: null });
});

function renderCard(id: string): void {
  render(
    <MemoryRouter initialEntries={[`/entries/${id}`]}>
      <Routes>
        <Route path="/entries/:id" element={<EntryCardScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('EntryCardScreen (S-05 integration)', () => {
  it('shows the operational event, shift context and honest offline state', async () => {
    const shift = await createShiftLocal(
      {
        journal_id: DEFAULT_JOURNAL_ID,
        shift_date: '2026-11-24',
        period_start: '2026-11-24T05:00:00.000Z',
        period_end: '2026-11-24T17:00:00.000Z',
        handover_comment: 'Смена сдана, журнал проверен',
      },
      supervisor,
    );
    const entry = await createLocalEntry(
      {
        ...entryInput,
        text: 'Установил заземление на КЛ-5',
        event_type: 'grounding',
        event_data: {
          action: 'applied',
          grounding_type: 'portable',
          point: 'КЛ-10 кВ, яч. 5',
          count: 1,
        },
      },
      author,
    );
    useAuthStore.setState({ user: author, initialized: true });

    renderCard(entry.id);

    expect(
      await screen.findByRole('heading', { name: 'Запись журнала' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Заземление').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Реестр заземлений' })).toHaveAttribute(
      'href',
      '/groundings',
    );
    expect(
      screen.getByRole('link', { name: /Все заземления/ }),
    ).toHaveAttribute(
      'href',
      `/?event_type=grounding&journal_id=${DEFAULT_JOURNAL_ID}`,
    );
    expect(screen.getAllByText('Сдана, ожидает приёмки').length).toBeGreaterThan(0);
    expect(screen.getByText(/Запись ещё не синхронизирована/)).toBeInTheDocument();
    expect(screen.getByTestId('offline-status-bar')).toBeInTheDocument();
    void shift;
  });

  it('shows server signatures, the ЭП caveat and signs the visa manually', async () => {
    const entry = await createLocalEntry(
      { ...entryInput, text: 'Проверил оборудование на участке' },
      author,
    );
    await db.entries.update(entry.id, {
      sync_status: 'synced',
      verified_at: '2026-11-24T09:00:00.000Z',
      verified_by: supervisor.id,
      version: 2,
    });
    const stored = (await db.entries.get(entry.id)) as JournalEntry;
    vi.spyOn(api, 'entry').mockResolvedValue({
      ...stored,
      signatures: [visaSignature],
    });
    const signEntry = vi
      .spyOn(api, 'signEntry')
      .mockResolvedValue(qualifiedSignature);
    useAuthStore.setState({
      user: supervisor,
      initialized: true,
      signature: {
        provider: 'simple',
        algorithm: 'HMAC-SHA256',
        auto_sign: false,
        legal_note: 'Простая ЭП не является КЭП.',
      },
    });

    renderCard(entry.id);

    expect(await screen.findByText('Подписи записи')).toBeInTheDocument();
    expect(screen.getAllByTestId('signature-badge')).toHaveLength(1);
    expect(screen.getByTestId('signature-hint')).toHaveTextContent(
      'не является КЭП',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Подписать визу' }));
    await waitFor(() => expect(signEntry).toHaveBeenCalledWith(entry.id));
    expect(await screen.findAllByTestId('signature-badge')).toHaveLength(2);
    expect(screen.getByText('КЭП')).toBeInTheDocument();
  });
});
