import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Permit } from '@logbook/shared';
import { db } from '../db/schema';
import { PermitDetailScreen, PermitsScreen } from './PermitsScreen';

const permit: Permit = {
  id: '01930000-0000-7000-8000-000000000701',
  source_id: 'seed',
  external_id: 'SEED-123',
  number: 'НД-123/2026',
  number_norm: 'НД1232026',
  year: 2026,
  type: 'permit_to_work',
  status: 'active',
  valid_from: '2026-11-01T00:00:00.000Z',
  valid_to: '2026-12-31T23:59:59.000Z',
  site_id: '01930000-0000-7000-8000-000000000401',
  work_description: 'Ремонт трубопровода на третьем стояке',
  responsible_user_id: '01930000-0000-7000-8000-000000000102',
  external_url: 'https://permits.example.local/123',
  pdf_url: null,
  pdf_hash: null,
  pdf_size_bytes: null,
  updated_at_external: '2026-11-01T00:00:00.000Z',
  version: 1,
  is_deleted: false,
};

function mockJson(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify(body),
    }),
  );
}

function renderDetail(): void {
  render(
    <MemoryRouter initialEntries={[`/permits/${permit.id}`]}>
      <Routes>
        <Route path="permits/:id" element={<PermitDetailScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  for (const table of db.tables) {
    await table.clear();
  }
  await db.permits.put(permit);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PermitsScreen PDF and deep links (OQ-03)', () => {
  it('opens the generated signed PDF and shows its metadata', async () => {
    mockJson({
      permit_id: permit.id,
      url: `/v1/permits/pdf/${permit.id}?token=abc`,
      expires_at: '2026-11-25T09:15:00.000Z',
      source: 'generated',
      hash: 'a'.repeat(64),
      size_bytes: 223_553,
      external_url: permit.external_url,
      deep_link: permit.external_url,
      pdf_url: null,
    });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    renderDetail();
    expect(
      await screen.findByRole('link', { name: /Открыть во внешней системе/ }),
    ).toHaveAttribute('href', permit.external_url!);

    await userEvent.click(screen.getByRole('button', { name: 'PDF наряда' }));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        `/v1/permits/pdf/${permit.id}?token=abc`,
        '_blank',
        'noreferrer',
      );
    });
    expect(await screen.findByText(/PDF сформирован сервером/)).toBeInTheDocument();
    expect(screen.getByText(/hash aaaaaaaaaaaaaaaa/)).toBeInTheDocument();
    expect(screen.getByText(/218 КБ/)).toBeInTheDocument();
  });

  it('opens the external PDF deep link when the source provides one', async () => {
    const externalPdf = 'https://permits.example.local/files/123.pdf';
    mockJson({
      permit_id: permit.id,
      url: `/v1/permits/pdf/${permit.id}?token=abc`,
      expires_at: '2026-11-25T09:15:00.000Z',
      source: 'external',
      hash: 'b'.repeat(64),
      size_bytes: null,
      external_url: permit.external_url,
      deep_link: permit.external_url,
      pdf_url: externalPdf,
    });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    renderDetail();
    await screen.findByRole('button', { name: 'PDF наряда' });
    await userEvent.click(screen.getByRole('button', { name: 'PDF наряда' }));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(externalPdf, '_blank', 'noreferrer');
    });
    expect(await screen.findByText(/PDF внешнего источника/)).toBeInTheDocument();
  });

  it('marks permits with PDF/deep links in the list', async () => {
    await db.permits.put({
      ...permit,
      pdf_url: 'https://permits.example.local/files/123.pdf',
      pdf_hash: 'c'.repeat(64),
      pdf_size_bytes: 1000,
    });
    const local = await db.permits.get(permit.id);
    expect(local?.pdf_url).toBeTruthy();

    render(
      <MemoryRouter>
        <PermitsScreen />
      </MemoryRouter>,
    );
    expect(await screen.findByText('НД-123/2026')).toBeInTheDocument();
    expect(screen.getByText('PDF')).toBeInTheDocument();
    expect(screen.getByText('deep link')).toBeInTheDocument();
  });
});
