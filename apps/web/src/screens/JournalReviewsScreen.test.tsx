import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_JOURNAL_ID,
  type JournalReview,
  type SignatureRecord,
} from '@logbook/shared';
import { api } from '../api/client';
import type { ApiUser } from '../api/types';
import { db } from '../db/schema';
import { useAuthStore } from '../stores/auth';
import { JournalReviewsScreen } from './JournalReviewsScreen';

const supervisor: ApiUser = {
  id: '01930000-0000-7000-8000-000000000102',
  full_name: 'Петров Пётр Петрович',
  role: 'supervisor',
  department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок' },
  status: 'active',
  email: 'supervisor@logbook.local',
};

const review: JournalReview = {
  id: '01930000-0000-7000-8000-000000003201',
  journal_id: DEFAULT_JOURNAL_ID,
  journal_key: 'main',
  period_start: '2026-11-01',
  period_end: '2026-11-30',
  reviewer_id: supervisor.id,
  reviewed_at: '2026-11-24T10:00:00.000Z',
  entries_count: 3,
  remarks: 'Замечаний нет',
  content_hash: 'c'.repeat(64),
};

const reviewSignature: SignatureRecord = {
  id: '01930000-0000-7000-8000-000000003301',
  entity_type: 'journal_review',
  entity_id: review.id,
  entity_version: 0,
  content_hash: review.content_hash,
  kind: 'simple',
  algorithm: 'HMAC-SHA256',
  value: 'review-signature',
  key_id: 'key-1',
  certificate_serial: null,
  certificate_subject: null,
  signer_id: supervisor.id,
  signed_at: '2026-11-24T10:00:00.000Z',
  status: 'valid',
  metadata: null,
  legal_note: 'Простая ЭП не является КЭП',
};

beforeEach(async () => {
  for (const table of db.tables) {
    await table.clear();
  }
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new Error('offline in test')),
  );
  useAuthStore.setState({
    user: supervisor,
    initialized: true,
    signature: {
      provider: 'simple',
      algorithm: 'HMAC-SHA256',
      auto_sign: true,
      legal_note: 'Простая ЭП не является КЭП.',
    },
  });
  vi.spyOn(api, 'reviews').mockResolvedValue({ items: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useAuthStore.setState({ user: null, signature: null });
});

describe('JournalReviewsScreen (S-14 ЭП integration)', () => {
  it('creates a review, shows the signature caveat and signs the visa', async () => {
    const createReview = vi
      .spyOn(api, 'createReview')
      .mockResolvedValue({ ...review, signature: reviewSignature });
    const signReview = vi
      .spyOn(api, 'signReview')
      .mockResolvedValue({ ...reviewSignature, id: 'sig-2' });
    const reviewSignatures = vi
      .spyOn(api, 'reviewSignatures')
      .mockResolvedValue({ items: [reviewSignature] });

    render(
      <MemoryRouter>
        <JournalReviewsScreen />
      </MemoryRouter>,
    );

    const hint = (await screen.findAllByTestId('signature-hint'))[0]!;
    expect(hint).toHaveTextContent('не является КЭП');
    expect(screen.getByText(/Визы подписываются: HMAC-SHA256/)).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'Зафиксировать визу' }),
    );

    expect(createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        journal_id: DEFAULT_JOURNAL_ID,
        period_start: expect.any(String),
        period_end: expect.any(String),
      }),
    );
    expect(await screen.findByText(/Виза подписана/)).toBeInTheDocument();
    expect(await screen.findByText(/Записей: 3/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Подписать визу' }));
    await waitFor(() =>
      expect(signReview).toHaveBeenCalledWith(review.id),
    );
    expect(await screen.findByText('Подписи визы')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Подписи' }));
    await waitFor(() =>
      expect(reviewSignatures).toHaveBeenCalledWith(review.id),
    );
    expect(await screen.findAllByTestId('signature-badge')).not.toHaveLength(0);
  });

  it('explains the online-only behaviour when the network is down', async () => {
    const getter = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    render(
      <MemoryRouter>
        <JournalReviewsScreen />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText(/Нет сети: визу можно зафиксировать только/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Зафиксировать визу' }),
    ).toBeDisabled();
    getter.mockRestore();
  });
});
